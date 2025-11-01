import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const dirsToClean = ['dist', '.well-known', '.workflow-data'];

for (const dir of dirsToClean) {
  try {
    rmSync(join(rootDir, dir), { recursive: true, force: true });
  } catch (error) {
    // Ignore errors if directory doesn't exist
  }
}
