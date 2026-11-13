// Build the package into dist/.
//
// esbuild bundles each entry with every published dependency left external,
// except `@workflow/world-sim`: that package is private (never published), so
// the parts used here (its event store and its build helper) are inlined.
// Declarations come from `tsc -p tsconfig.build.json`.
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
].flatMap((name) => [name, `${name}/*`]);

rmSync(join(root, 'dist'), { recursive: true, force: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  target: 'es2023',
  outdir: 'dist',
  outbase: 'src',
  sourcemap: 'linked',
  logLevel: 'warning',
};

// Runs in the Worker (workerd).
await build({
  ...common,
  entryPoints: ['src/index.ts'],
  platform: 'neutral',
  external: [...external, 'cloudflare:*', 'node:*'],
});

// Runs in Node at build time.
await build({
  ...common,
  entryPoints: ['src/build.ts'],
  platform: 'node',
  external,
});
