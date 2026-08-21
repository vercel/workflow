import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS lint rule, no type declarations
import {
  formatFindings,
  scanPackage,
} from '../../../scripts/lint/module-scope-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * `@workflow/world-postgres` is loaded through `getRuntimeRequire()` with
 * `webpackIgnore`/`turbopackIgnore` (see `packages/core/src/runtime/world.ts`),
 * so today Node's module cache dedupes it and one process holds one copy. That
 * is a property of how it is *loaded*, not of how it is written — the same was
 * true of `@workflow/world-vercel` until vercel/workflow#3493 made it bundled
 * and every module-scope binding in it became per-layer state.
 *
 * This package is already clean. The assertion keeps it that way, so a future
 * change to the loading strategy is a config decision rather than a silent
 * class of bug.
 */
describe('module-scope state rule', () => {
  it('reports nothing for @workflow/world-postgres', () => {
    const findings = scanPackage(
      path.join(repoRoot, 'packages/world-postgres'),
      repoRoot
    );
    expect(findings, formatFindings(findings)).toEqual([]);
  });
});
