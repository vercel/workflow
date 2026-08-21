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
 * A local mirror of the sweep in `@workflow/utils`, which owns this rule and
 * its own tests and checks every published world package. Repeated here so the
 * signal arrives when you run just this package's tests.
 *
 * This package is deduped today only because `getRuntimeRequire()` loads it:
 * a property of how it is loaded, not of how it is written, and exactly what
 * changed for world-vercel in vercel/workflow#3493.
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
