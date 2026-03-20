import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('framework integration monorepo docs stay aligned with Next.js behavior', () => {
  it('documents projectRoot and links back to the Next.js monorepo reference', () => {
    const frameworkIntegrations = read(
      'docs/content/docs/how-it-works/framework-integrations.mdx'
    );

    expect(frameworkIntegrations).toContain(
      '### Monorepos and Workspace Imports'
    );
    expect(frameworkIntegrations).toContain('projectRoot');
    expect(frameworkIntegrations).toContain('outputFileTracingRoot');
    expect(frameworkIntegrations).toContain(
      '/docs/api-reference/workflow-next/with-workflow#monorepos-and-workspace-imports'
    );
  });
});
