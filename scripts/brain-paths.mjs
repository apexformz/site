import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const webRoot = fileURLToPath(new URL('../', import.meta.url));
const bundledBrain = path.join(webRoot, 'Apexformz_brain');
export const brainRoot = path.resolve(process.env.APEXFORMZ_BRAIN_DIR ||
  (existsSync(path.join(bundledBrain, 'package.json')) ? bundledBrain : path.join(webRoot, '../Apexformz_brain')));
