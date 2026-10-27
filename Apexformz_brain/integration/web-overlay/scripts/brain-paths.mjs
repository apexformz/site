import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const webRoot = fileURLToPath(new URL('../', import.meta.url));
export const brainRoot = path.resolve(process.env.APEXFORMZ_BRAIN_DIR || path.join(webRoot, '../Apexformz_brain'));
