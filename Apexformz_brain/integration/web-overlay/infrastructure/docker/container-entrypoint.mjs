import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Containers use the host's existing database; preserve database, credentials and query options. */
export function containerDatabaseUrl(value) {
  let connection;
  try { connection = new URL(value); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  if (['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname)) connection.hostname = 'host.docker.internal';
  return connection.href;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in apps/backend/.env');
    process.env.DATABASE_URL = containerDatabaseUrl(process.env.DATABASE_URL);
    const script = process.argv[2];
    if (!script || !path.isAbsolute(script)) throw new Error('The container command must be an absolute script path');
    // Execute in this process so container signals reach the backend and its normal shutdown handlers.
    process.argv = [process.execPath, script, ...process.argv.slice(3)];
    await import(pathToFileURL(script));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
