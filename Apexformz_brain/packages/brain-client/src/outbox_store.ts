/**
 * Durable outbox store for the Brain worker (TRD 13 "never discard unsynced sessions silently").
 *
 * The runtime's in-memory outbox writes every event here on append and deletes it on acknowledgement. If the tab
 * closes or the worker dies before the syncer has shipped the events, they are still in IndexedDB and are
 * recovered on the next launch (`recover_outbox` message, `recoverPersistedOutbox`). Writes are serialized and
 * never awaited on the real-time path; failures are counted, not thrown.
 *
 * Only pose-derived events are stored (envelopes carry no media), matching the privacy posture of the outbox.
 */
import type { EventEnvelope } from '@apexformz/contracts';
import type { OutboxSink } from '@apexformz/runtime';

export interface OutboxStore extends OutboxSink {
  all(): Promise<EventEnvelope[]>;
  readonly stats: { puts: number; removes: number; failures: number; backend: 'indexeddb' | 'memory' };
  close(): void;
}

const DB_NAME = 'apexformz-brain-outbox';
const STORE = 'events';

/** In-memory fallback for environments without IndexedDB (tests, locked-down browsers). Not durable. */
export class MemoryOutboxStore implements OutboxStore {
  private events = new Map<string, EventEnvelope>();
  readonly stats = { puts: 0, removes: 0, failures: 0, backend: 'memory' as const };

  put(event: EventEnvelope): void {
    this.events.set(event.event_id, event);
    this.stats.puts++;
  }

  remove(eventIds: string[]): void {
    for (const id of eventIds) this.events.delete(id);
    this.stats.removes += eventIds.length;
  }

  all(): Promise<EventEnvelope[]> {
    return Promise.resolve([...this.events.values()]);
  }

  close(): void {
    this.events.clear();
  }
}

export class IndexedDbOutboxStore implements OutboxStore {
  readonly stats = { puts: 0, removes: 0, failures: 0, backend: 'indexeddb' as const };
  private db: Promise<IDBDatabase>;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly factory: IDBFactory, private readonly name = DB_NAME) {
    this.db = new Promise((resolve, reject) => {
      const req = this.factory.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'event_id' });
          store.createIndex('session_id', 'session_id', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
      req.onblocked = () => reject(new Error('indexeddb open blocked'));
    });
  }

  private enqueue(op: (db: IDBDatabase) => Promise<void>): void {
    this.chain = this.chain
      .then(() => this.db)
      .then(op)
      .catch(() => {
        this.stats.failures++;
      });
  }

  private tx(db: IDBDatabase, mode: IDBTransactionMode, body: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
      body(tx.objectStore(STORE));
    });
  }

  put(event: EventEnvelope): void {
    this.stats.puts++;
    this.enqueue((db) => this.tx(db, 'readwrite', (s) => void s.put(event)));
  }

  remove(eventIds: string[]): void {
    if (!eventIds.length) return;
    this.stats.removes += eventIds.length;
    this.enqueue((db) => this.tx(db, 'readwrite', (s) => eventIds.forEach((id) => void s.delete(id))));
  }

  async all(): Promise<EventEnvelope[]> {
    await this.chain;
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as EventEnvelope[]);
      req.onerror = () => reject(req.error ?? new Error('indexeddb read failed'));
    });
  }

  close(): void {
    void this.db.then((db) => db.close()).catch(() => undefined);
  }
}

/** IndexedDB when the worker has it, otherwise the memory fallback (reported in `stats.backend`). */
export function createOutboxStore(): OutboxStore {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (factory) {
    try {
      return new IndexedDbOutboxStore(factory);
    } catch {
      // fall through
    }
  }
  return new MemoryOutboxStore();
}
