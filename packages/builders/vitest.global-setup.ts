import { applySwcTransform } from './src/apply-swc-transform.js';

/**
 * SWC compiles the workflow wasm plugin on first use and caches the compiled
 * module under `<cwd>/.swc/plugins`. Test workers share that cwd, so on a cold
 * cache they all compile and write the same file concurrently. On Windows,
 * overwriting a file another process has memory-mapped fails with
 * "os error 1224". Compiling once here, before any worker starts, means
 * workers only ever read the cached module.
 */
export default async function setup() {
  await applySwcTransform('warm-swc-plugin-cache.ts', '', 'workflow');
}
