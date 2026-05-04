import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// `pack.ts` writes tarballs and `catalog.json` into `public/` before vite
// runs. Vite then writes the bundled SPA into the same directory without
// emptying it (so the tarballs survive). We disable Vite's `publicDir`
// feature (which would otherwise copy `public/` into itself) for the same
// reason.
export default defineConfig({
  plugins: [preact()],
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: false,
    sourcemap: true,
  },
});
