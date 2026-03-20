import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('hook conflict docs stay aligned across event-sourcing and troubleshooting pages', () => {
  it('uses HookConflictError consistently', () => {
    const eventSourcingDoc = read(
      'docs/content/docs/how-it-works/event-sourcing.mdx'
    );
    const hookConflictDoc = read('docs/content/docs/errors/hook-conflict.mdx');

    expect(hookConflictDoc).toContain('HookConflictError');
    expect(eventSourcingDoc).toContain('HookConflictError');

    expect(eventSourcingDoc).not.toContain(
      "hook's promise to reject with a `WorkflowRuntimeError`"
    );
    expect(eventSourcingDoc).not.toContain(
      'workflow will fail with a `WorkflowRuntimeError` when the hook is awaited'
    );
  });
});
