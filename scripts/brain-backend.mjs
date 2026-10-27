import path from 'node:path';
import { spawn } from 'node:child_process';
import { brainRoot, webRoot } from './brain-paths.mjs';

const child = spawn(process.execPath, [path.join(brainRoot, 'tools/web-backend.mjs'), ...process.argv.slice(2), '--web-root', webRoot], {
  stdio: 'inherit', windowsHide: true,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
