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
 * The rule itself is covered in `@workflow/world-vercel`; this keeps
 * `@workflow/world-local` — bundled into the host build for the same reason —
 * honest in its own `turbo test` job.
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
