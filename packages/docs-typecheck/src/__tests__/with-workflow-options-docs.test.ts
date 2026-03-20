import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('withWorkflow docs stay aligned with the public local config surface', () => {
  it('documents only the supported local options and does not mention removed dataDir config', () => {
    const doc = read(
      'docs/content/docs/api-reference/workflow-next/with-workflow.mdx'
    );
    const source = read('packages/next/src/index.ts');

    expect(source).toContain('lazyDiscovery?: boolean;');
    expect(source).toContain('port?: number;');
    expect(source).not.toContain('dataDir?: string;');

    expect(doc).toContain(
      '`withWorkflow` accepts an optional second argument to control local development behavior.'
    );
    expect(doc).toContain('workflows.lazyDiscovery');
    expect(doc).toContain('workflows.local.port');
    expect(doc).not.toContain('workflows.local.dataDir');
    expect(doc).not.toMatch(/\bdataDir\b/);
  });
});
