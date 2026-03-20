import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('Next.js monorepo docs linkage', () => {
  it('keeps the getting-started guide pointed at the detailed reference section', () => {
    const gettingStarted = read('docs/content/docs/getting-started/next.mdx');

    expect(gettingStarted).toContain(
      '/docs/api-reference/workflow-next/with-workflow#monorepos-and-workspace-imports'
    );
  });

  it('keeps the referenced monorepo section present in the API reference', () => {
    const withWorkflow = read(
      'docs/content/docs/api-reference/workflow-next/with-workflow.mdx'
    );

    expect(withWorkflow).toContain('### Monorepos and Workspace Imports');
    expect(withWorkflow).toContain('outputFileTracingRoot');
  });
});
