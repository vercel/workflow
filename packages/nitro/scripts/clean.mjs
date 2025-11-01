import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

try {
  rmSync(distDir, { recursive: true, force: true });
} catch (error) {
  // Ignore errors if directory doesn't exist
}
