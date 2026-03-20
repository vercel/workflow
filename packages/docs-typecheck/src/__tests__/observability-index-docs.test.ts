import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('observability index docs stay aligned with machine-readable guidance', () => {
  it('links the entrypoint page to stable fields, error codes, and lifecycle events', () => {
    const doc = read('docs/content/docs/observability/index.mdx');

    expect(doc).toContain('## Machine-Readable Surfaces');
    expect(doc).toContain('workflowName');
    expect(doc).toContain('stepName');
    expect(doc).toContain('error.code');
    expect(doc).toContain('workflow.error.code');
    expect(doc).toContain('step_started');
    expect(doc).toContain('step_retrying');
    expect(doc).toContain('hook_created');
    expect(doc).toContain('hook_conflict');
    expect(doc).toContain('hook_disposed');
    expect(doc).toContain('/docs/api-reference/workflow-api/get-world');
    expect(doc).toContain('/docs/foundations/errors-and-retries');
    expect(doc).toContain('/docs/how-it-works/event-sourcing');
    expect(doc).toContain('/docs/how-it-works/encryption');
  });
});
