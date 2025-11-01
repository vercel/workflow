import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  // Windows ignores POSIX execute bits; nothing to do.
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', 'bin', 'run.js');

chmodSync(binPath, 0o755);
