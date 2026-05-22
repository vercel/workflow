import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// Layout:
// - `public/` holds static assets (tarballs and `catalog.json`) that pack.ts
//   writes before vite runs. In dev mode, vite serves them at the root of
//   the dev server. During `vite build`, vite copies them into `dist/`.
// - `dist/` is the final build output that Vercel serves (set as
//   `outputDirectory` in vercel.json).
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
