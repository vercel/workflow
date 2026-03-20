import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('start() troubleshooting docs stay aligned with runtime behavior', () => {
  it('documents the invalid workflow function runtime error and the required fixes', () => {
    const errorDoc = read(
      'docs/content/docs/errors/start-invalid-workflow-function.mdx'
    );
    const startDoc = read(
      'docs/content/docs/api-reference/workflow-api/start.mdx'
    );
    const nextGuide = read('docs/content/docs/getting-started/next.mdx');
    const nestGuide = read('docs/content/docs/getting-started/nestjs.mdx');

    expect(errorDoc).toContain(
      "'start' received an invalid workflow function. Ensure the Workflow Development Kit is configured correctly and the function includes a 'use workflow' directive."
    );
    expect(errorDoc).toContain('"use workflow"');
    expect(errorDoc).toContain('withWorkflow');
    expect(startDoc).toContain('/docs/errors/start-invalid-workflow-function');
    expect(nextGuide).toContain('/docs/errors/start-invalid-workflow-function');

    expect(nestGuide).toContain('/docs/errors/start-invalid-workflow-function');
    expect(nestGuide).toContain('"use workflow"');
    expect(nestGuide).toContain(
      'Workflow files must be inside the `src/` directory'
    );
  });
});
