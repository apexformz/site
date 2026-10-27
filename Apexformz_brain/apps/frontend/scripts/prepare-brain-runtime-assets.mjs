/** Copy the installed browser inference runtimes into /public; never downloads files. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));

async function installedPackage(name) {
  let directory = path.dirname(require.resolve(name));
  for (;;) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) {
        if (!/^[\d\w.+-]+$/.test(metadata.version)) throw new Error(`Invalid installed ${name} version`);
        return { directory, ...metadata };
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate installed package ${name}`);
    directory = parent;
  }
}

async function writeIfChanged(filename, text) {
  try { if (await readFile(filename, 'utf8') === text) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, text);
}

async function stage(pkg, sourceDirectory, files, publicDirectory) {
  const destination = path.join(frontend, 'public', publicDirectory);
  await mkdir(destination, { recursive: true });
  const manifest = { package: pkg.name, version: pkg.version, license: pkg.license ?? null, files: [] };
  for (const name of files.sort()) {
    const source = path.join(sourceDirectory, name);
    const bytes = await readFile(source);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const target = path.join(destination, name);
    let unchanged = false;
    try {
      if ((await stat(target)).size === bytes.length) {
        unchanged = createHash('sha256').update(await readFile(target)).digest('hex') === sha256;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!unchanged) await copyFile(source, target);
    manifest.files.push({ name, bytes: bytes.length, sha256 });
  }
  // Keep the installed package attribution alongside the distribution it describes.
  for (const name of (await readdir(pkg.directory)).filter((name) => /^(license|notice|copyright)(\.|$)/i.test(name))) {
    await copyFile(path.join(pkg.directory, name), path.join(destination, name));
  }
  await writeIfChanged(path.join(destination, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return `/${publicDirectory.replaceAll(path.sep, '/')}/`;
}

const ort = await installedPackage('onnxruntime-web');
const vision = await installedPackage('@mediapipe/tasks-vision');
const ortDist = path.join(ort.directory, 'dist');
const ortFiles = (await readdir(ortDist)).filter((name) => name === 'ort.webgpu.bundle.min.mjs' || /^ort-wasm.*\.(mjs|wasm)$/.test(name));
if (!ortFiles.includes('ort.webgpu.bundle.min.mjs') || !ortFiles.some((name) => name.endsWith('.wasm'))) throw new Error('Installed ONNX Runtime browser assets are incomplete');
const visionWasm = path.join(vision.directory, 'wasm');
const visionFiles = (await readdir(visionWasm)).filter((name) => /\.(js|wasm)$/.test(name));
if (!visionFiles.includes('vision_wasm_internal.wasm') || !visionFiles.includes('vision_wasm_internal.js')) throw new Error('Installed MediaPipe browser assets are incomplete');
const ortBase = await stage(ort, ortDist, ortFiles, path.join('runtime', 'onnxruntime-web', ort.version));
const visionBase = await stage(vision, visionWasm, visionFiles, path.join('runtime', 'mediapipe-tasks-vision', vision.version));
const config = {
  schema_version: 1,
  onnxruntime: { version: ort.version, module_url: `${ortBase}ort.webgpu.bundle.min.mjs`, wasm_base_url: ortBase },
  mediapipe: { version: vision.version, wasm_base_url: visionBase.slice(0, -1) },
};
await writeIfChanged(path.join(frontend, 'src/lib/brain/runtime-assets.generated.json'), `${JSON.stringify(config, null, 2)}\n`);
console.log(`Local Brain assets ready: onnxruntime-web ${ort.version}, MediaPipe Tasks Vision ${vision.version} (installed packages; no downloads).`);
