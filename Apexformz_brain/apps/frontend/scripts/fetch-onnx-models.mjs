#!/usr/bin/env node
/**
 * Fetch the ONNX pose models used by the Brain worker's ONNX backend.
 *
 *   node scripts/fetch-onnx-models.mjs
 *
 * Node built-ins only. Tries the Hugging Face mirror (Tau-J/RTMPose) for a direct
 * .onnx first, then the OpenMMLab SDK zip (extracted with a minimal zip reader on
 * zlib.inflateRawSync). Output: public/models/rtmo-s_640.onnx plus a .sha256 file.
 * Models are Apache-2.0 (OpenMMLab mmpose / RTMO). *.onnx is gitignored at the repo root.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'models');
mkdirSync(outDir, { recursive: true });

const MODELS = [
  {
    file: 'rtmo-s_640.onnx',
    label: 'rtmo-s_8xb32-600e_body7-640x640 (RTMO-s, COCO-17, Apache-2.0)',
    hfRepo: 'Tau-J/RTMPose',
    hfMatch: (name) => /rtmo-s.*640/i.test(name) && name.endsWith('.onnx'),
    zipUrls: [
      'https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211.zip',
      'https://huggingface.co/Tau-J/RTMPose/resolve/main/rtmo/onnx_sdk/rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211.zip',
    ],
  },
];

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimal ZIP reader: returns the first entry whose name passes `match` (store or deflate only). */
function extractFromZip(buf, match) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (!match(name)) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) return { name, data: Buffer.from(data) };
    if (method === 8) return { name, data: inflateRawSync(data) };
    throw new Error(`zip: unsupported compression method ${method} for ${name}`);
  }
  throw new Error('zip: no matching entry');
}

async function fetchModel(m) {
  const target = join(outDir, m.file);
  if (existsSync(target) && statSync(target).size > 1_000_000) {
    console.log(`exists  ${m.file} (${(statSync(target).size / 1048576).toFixed(1)} MB)`);
    return;
  }
  let bytes = null;
  let source = null;
  try {
    const api = await (await fetch(`https://huggingface.co/api/models/${m.hfRepo}`)).json();
    const hit = (api.siblings ?? []).map((s) => s.rfilename).find(m.hfMatch);
    if (hit) {
      source = `https://huggingface.co/${m.hfRepo}/resolve/main/${hit}`;
      console.log(`fetch   ${source}`);
      bytes = await download(source);
    }
  } catch (e) {
    console.warn(`hf      ${m.file}: ${e.message}`);
  }
  for (const url of m.zipUrls) {
    if (bytes) break;
    try {
      console.log(`fetch   ${url}`);
      const zip = await download(url);
      const entry = extractFromZip(zip, (n) => n.endsWith('.onnx'));
      console.log(`extract ${entry.name}`);
      bytes = entry.data;
      source = url;
    } catch (e) {
      console.warn(`zip     ${m.file}: ${e.message}`);
    }
  }
  if (!bytes) throw new Error(`could not obtain ${m.file} from any source`);
  writeFileSync(target, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${target}.sha256`, `${sha}  ${m.file}\n${m.label}\nsource: ${source}\n`);
  console.log(`wrote   ${m.file} ${(bytes.length / 1048576).toFixed(1)} MB sha256=${sha}`);
}

for (const m of MODELS) {
  await fetchModel(m);
}
