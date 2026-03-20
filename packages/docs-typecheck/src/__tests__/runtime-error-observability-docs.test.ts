import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('runtime error and lifecycle docs stay aligned with machine-readable surfaces', () => {
  it('documents workflow run error codes and observability fields', () => {
    const errorsDoc = read('docs/content/docs/foundations/errors-and-retries.mdx');

    expect(errorsDoc).toContain('WorkflowRunFailedError');
    expect(errorsDoc).toContain('USER_ERROR');
    expect(errorsDoc).toContain('RUNTIME_ERROR');
    expect(errorsDoc).toContain('error.code');
    expect(errorsDoc).toContain('workflow.error.code');
  });

  it('documents event lifecycle details for retries and hook conflicts', () => {
    const eventSourcingDoc = read('docs/content/docs/how-it-works/event-sourcing.mdx');

    expect(eventSourcingDoc).toContain('step_retrying');
    expect(eventSourcingDoc).toContain('hook_conflict');
    expect(eventSourcingDoc).toContain('step_started');
    expect(eventSourcingDoc).toContain('hook_created');
    expect(eventSourcingDoc).toContain('hook_disposed');
  });
});
