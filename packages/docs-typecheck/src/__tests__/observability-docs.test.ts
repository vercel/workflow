import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('observability and agent docs stay aligned with public APIs', () => {
  it('documents DurableAgent machine-readable stream result fields', () => {
    const doc = read(
      'docs/content/docs/api-reference/workflow-ai/durable-agent.mdx'
    );

    expect(doc).toContain('toolCalls');
    expect(doc).toContain('toolResults');
    expect(doc).toContain('timeout');
  });

  it('keeps hook-conflict error text aligned with the runtime error class', () => {
    const doc = read('docs/content/docs/errors/hook-conflict.mdx');

    expect(doc).toContain(
      'Hook token "<token>" is already in use by another workflow'
    );
  });

  it('documents parseWorkflowName for machine-readable workflowName fields', () => {
    const doc = read(
      'docs/content/docs/api-reference/workflow-api/get-world.mdx'
    );

    expect(doc).toContain('parseWorkflowName');
    expect(doc).toContain('workflowName');
  });

  it('documents both encryption key overload styles', () => {
    const doc = read('docs/content/docs/how-it-works/encryption.mdx');

    expect(doc).toContain('getEncryptionKeyForRun(run)');
    expect(doc).toContain('getEncryptionKeyForRun(runId, context?)');
  });
});
