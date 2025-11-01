import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nextDir = join(__dirname, '..', '.next');

try {
  rmSync(nextDir, { recursive: true, force: true });
} catch (error) {
  // Ignore errors if directory doesn't exist
}
