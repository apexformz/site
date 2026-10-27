/**
 * Run the edge signal pipeline + feature engine over a PoseFrame JSONL file with a sport pack's
 * feature specs and write one JSON row per frame: {stream_id, frame_id, timestamp_ms, features: {id: value|null}, reasons: {id: reason}}.
 *
 * Train-time feature extraction therefore uses exactly the code the browser worker runs, so the
 * thresholds fitted offline (ml/sports/<sport>/fit_phase_thresholds.py) mean the same thing live.
 *
 *   npx tsx tools/extract_features.ts --pack squash --view back --handedness right --stream cap-0001/back \
 *       --in data/squash/cap-0001.back.pose.jsonl --out data/squash/features.jsonl [--append]
 *
 * Sport-agnostic: the sport is only a pack id on the command line.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Handedness, PoseFrame, ViewLabel } from '@apexformz/contracts';
import { validate } from '@apexformz/contracts';
import { SignalPipeline } from '@apexformz/signal';
import { FeatureEngine } from '@apexformz/features';
import { DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET, loadSportPack } from '@apexformz/sport-runtime';
import { readPackDir } from '@apexformz/sport-runtime/node';

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packId = arg('pack');
  const view = arg('view', 'unknown') as ViewLabel;
  const handedness = arg('handedness', 'unknown') as Handedness;
  const input = arg('in');
  const output = arg('out');
  const streamId = arg('stream', path.basename(input).replace(/\.jsonl$/, ''));
  const append = process.argv.includes('--append');

  const bundle = await loadSportPack(await readPackDir(path.resolve(here, '..', 'sport-packs', packId)), {
    platform: 'web',
    hmac_keys: { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET },
  });
  const specs = bundle.technique_criteria.features;
  const signal = new SignalPipeline({ view });
  const engine = new FeatureEngine(specs);
  const ctx = { view, handedness, handedness_assumed: handedness === 'unknown' };

  const out = fs.createWriteStream(output, { flags: append ? 'a' : 'w' });
  const rl = readline.createInterface({ input: fs.createReadStream(input, { encoding: 'utf-8' }), crlfDelay: Infinity });
  let n = 0;
  let dropped = 0;
  let invalid = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line) as PoseFrame;
    const v = validate('poseFrame', frame);
    if (!v.ok) {
      invalid++;
      continue;
    }
    const sig = signal.process(frame);
    if (sig.dropped || !sig.frame) {
      dropped++;
      continue;
    }
    if (sig.time_gap || sig.track_changed) engine.reset();
    const features: Record<string, number | null> = {};
    const reasons: Record<string, string> = {};
    for (const [id, f] of engine.compute(signal.window, ctx)) {
      features[id] = f.valid ? f.value : null;
      if (!f.valid && f.reason) reasons[id] = f.reason;
    }
    out.write(JSON.stringify({ stream_id: streamId, frame_id: frame.frame_id, timestamp_ms: frame.timestamp_ms, view, features, reasons }) + '\n');
    n++;
  }
  out.end();
  await new Promise((r) => out.on('finish', r));
  console.log(JSON.stringify({ pack: `${bundle.manifest.id}@${bundle.manifest.version}`, stream_id: streamId, frames: n, dropped, invalid, features: specs.length, out: output }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
