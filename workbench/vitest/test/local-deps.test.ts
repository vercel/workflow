/**
 * Regression test for vercel/workflow#2289: a workflow/step importing a
 * plain local TypeScript helper (no directives) must work under the
 * vitest plugin. The helper uses an enum, so this fails if the helper is
 * externalized from the step bundle (Node's native loader refuses
 * non-erasable TypeScript syntax) instead of bundled inline.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { start } from 'workflow/api';
import { localHelperWorkflow } from '../workflows/local-deps.js';

it('runs a workflow whose body and steps use a local .ts helper', async () => {
  const run = await start(localHelperWorkflow, ['hello']);
  await expect(run.returnValue).resolves.toBe('hello:recipe');
});

it('bundles local helpers into the step bundle instead of externalizing', async () => {
  // In this workbench, @workflow/vitest resolves to a workspace symlink, so
  // the generated bundles happen to be loaded through vitest's module runner,
  // which transforms `.ts` imports and masks the runtime failure. In a real
  // app install they are loaded by Node's native ESM loader, where an
  // externalized `.ts` import crashes. Assert on the bundle content directly
  // so this guards the fix in either environment.
  const bundle = await readFile(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '.workflow-vitest',
      '__step_registrations.mjs'
    ),
    'utf8'
  );
  expect(bundle).not.toMatch(/from\s*["'][^"']*local-helper\.ts["']/);
  // The helper's implementation must be inlined in the bundle (esbuild
  // inlines the enum member accesses, so assert on the function name).
  expect(bundle).toContain('function buildPayload');
});
