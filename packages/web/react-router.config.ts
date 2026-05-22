import type { Config } from '@react-router/dev/config';
import { vercelPreset } from '@vercel/react-router/vite';

// Enable the Vercel preset only when building the `packages/web` Vercel
// deployment itself. The preset changes the server build layout (per-route
// bundles under `build/server/<runtime>_<hash>/`), which breaks `server.js`
// (used for self-hosting and by the CLI via `@workflow/web/server`) since it
// imports `build/server/index.js`.
//
// We cannot gate this on `process.env.VERCEL` alone because the `docs`
// deployment also runs `pnpm pack` on this package with `VERCEL=1` set, and
// in that case we need the standard layout so the published tarball works.
// Set `WORKFLOW_WEB_VERCEL_BUILD=1` in the web Vercel project's environment
// variables to opt in.
const presets: Config['presets'] =
  process.env.WORKFLOW_WEB_VERCEL_BUILD === '1' ? [vercelPreset()] : [];

export default {
  appDirectory: 'app',
  ssr: true,
  presets,
} satisfies Config;
