import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { workflow } from 'workflow/vite';

export default defineConfig({
  plugins: [workflow(), tanstackStart(), nitro(), viteReact()],
  nitro: {
    plugins: ['./plugins/start-pg-world.ts'],
    // `ws` (world-vercel's events WS transport) has optional native
    // accelerator deps (`bufferutil`, `utf-8-validate`) that aren't
    // installed here. Nitro bundles `ws` by default, and Rollup fails the
    // whole build trying to statically resolve `require('bufferutil')`
    // ("Could not resolve \"bufferutil\" imported by \"ws\"") since the
    // package isn't present. `ws`'s own source wraps that require in a
    // try/catch and falls back to a pure-JS implementation when it throws
    // — so externalizing just the two optional accelerators (not `ws`
    // itself) lets Rollup leave them as unresolved `require()` calls that
    // `ws` safely catches at runtime, while `ws` stays fully bundled.
    // Deliberately NOT `external: ['ws']`: unlike Next.js's
    // `serverExternalPackages` (which Vercel's Next-aware build traces and
    // copies into the deployed function's `node_modules`), Nitro's Vercel
    // preset doesn't copy an externalized package's `node_modules` into
    // the deployed function — that produced a *worse* failure
    // (`Cannot find package 'ws'`) at runtime on a real deployment.
    rollupConfig: {
      external: ['bufferutil', 'utf-8-validate'],
    },
  },
});
