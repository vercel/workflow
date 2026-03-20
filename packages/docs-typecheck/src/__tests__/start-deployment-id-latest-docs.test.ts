import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('start() deploymentId latest docs stay aligned with runtime behavior', () => {
  it('documents latest deployment routing in the API reference and common patterns guide', () => {
    const startDoc = read(
      'docs/content/docs/api-reference/workflow-api/start.mdx'
    );
    const patternsDoc = read(
      'docs/content/docs/foundations/common-patterns.mdx'
    );

    expect(startDoc).toContain('### Using `deploymentId: "latest"`');
    expect(startDoc).toContain('Vercel-specific feature');
    expect(startDoc).toContain('same production target');
    expect(startDoc).toContain('same git branch for preview deployments');
    expect(startDoc).toContain('workflow ID');
    expect(startDoc).toContain('backward-compatible across deployments');

    expect(patternsDoc).toContain(
      '/docs/api-reference/workflow-api/start#using-deploymentid-latest'
    );
    expect(patternsDoc).toContain(
      'This is currently a Vercel-specific feature.'
    );
    expect(patternsDoc).toContain(
      'function name, file path, argument types, and return type must remain compatible across deployments'
    );
  });
});
