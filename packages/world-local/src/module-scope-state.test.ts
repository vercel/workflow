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
 * This package is bundled into the host application's server build, so one
 * process holds one copy of each of its modules per bundler layer.
 */
describe('module-scope state rule', () => {
  it('reports nothing for @workflow/world-local', () => {
    const findings = scanPackage(
      path.join(repoRoot, 'packages/world-local'),
      repoRoot
    );
    expect(findings, formatFindings(findings)).toEqual([]);
  });
});
