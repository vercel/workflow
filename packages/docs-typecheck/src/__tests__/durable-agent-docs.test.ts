import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('DurableAgent docs stay aligned with public stream result fields', () => {
  it('documents the full stream result shape and accumulation options', () => {
    const doc = read(
      'docs/content/docs/api-reference/workflow-ai/durable-agent.mdx'
    );

    expect(doc).toContain('toolCalls');
    expect(doc).toContain('toolResults');
    expect(doc).toContain('experimental_output');
    expect(doc).toContain('uiMessages');
    expect(doc).toContain('collectUIMessages');
    expect(doc).toContain('prepareStep');
    expect(doc).toContain('Default `maxSteps` is unlimited');
  });
});
