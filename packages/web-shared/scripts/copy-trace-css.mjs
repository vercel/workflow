import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(import.meta.dirname, '..', 'src', 'trace-viewer');
const DEST_DIR = join(import.meta.dirname, '..', 'dist', 'trace-viewer');

mkdirSync(DEST_DIR, { recursive: true });

for (const entry of readdirSync(SRC_DIR)) {
  const srcPath = join(SRC_DIR, entry);
  if (statSync(srcPath).isFile() && entry.endsWith('.css')) {
    const destPath = join(DEST_DIR, entry);
    copyFileSync(srcPath, destPath);
    console.log(`Copied ${srcPath} -> ${destPath}`);
  }
}
