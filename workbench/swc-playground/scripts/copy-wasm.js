/**
 * Copies the WASM build artifacts from packages/swc-playground-wasm/pkg/
 * into public/wasm/ so they can be served as static assets.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const pkgDir = new URL(
  '../../../packages/swc-playground-wasm/pkg/',
  import.meta.url
);

if (!existsSync(pkgDir)) {
  console.error(
    `WASM package not found at ${pkgDir}.\n` +
      'Run "pnpm build" in packages/swc-playground-wasm first.'
  );
  process.exit(1);
}

const publicWasmDir = new URL('../public/wasm/', import.meta.url);
mkdirSync(publicWasmDir, { recursive: true });

// Copy the .wasm binary and JS glue to public/ (served as static assets via CDN)
const files = ['swc_playground_wasm_bg.wasm', 'swc_playground_wasm.js'];

for (const file of files) {
  copyFileSync(new URL(file, pkgDir), new URL(file, publicWasmDir));
}

console.log('WASM artifacts copied successfully.');
