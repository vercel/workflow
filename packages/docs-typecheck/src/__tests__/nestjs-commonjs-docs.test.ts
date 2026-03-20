import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('NestJS docs stay aligned with supported module formats', () => {
  it('documents CommonJS consistently across the full guide', () => {
    const guide = read('docs/content/docs/getting-started/nestjs.mdx');
    const readme = read('packages/nest/README.md');

    expect(readme).toContain("moduleType: 'commonjs'");
    expect(readme).toContain("distDir: 'dist'");

    expect(guide).toContain('### Choose Your Module Format');
    expect(guide).toContain('"type": "module"');
    expect(guide).toContain("moduleType: 'commonjs'");
    expect(guide).toContain("distDir: 'dist'");

    const importSection = guide.slice(
      guide.indexOf('## Import the WorkflowModule'),
      guide.indexOf('## Create Your First Workflow')
    );
    expect(importSection).toContain('If you chose CommonJS above');
    expect(importSection).toContain("moduleType: 'commonjs'");
    expect(importSection).toContain("distDir: 'dist'");
    expect(importSection).toContain(
      'The `.js` local import specifiers in this example are the ESM form.'
    );

    const controllerSection = guide.slice(
      guide.indexOf('## Create Your Controller'),
      guide.indexOf('## Run in development')
    );
    expect(controllerSection).toContain(
      'The `.js` extension shown in this example is the ESM form.'
    );

    const configSection = guide.slice(
      guide.indexOf('## Configuration Options'),
      guide.indexOf('## Deploying to production')
    );
    expect(configSection).toContain("moduleType: 'es6'");
    expect(configSection).toContain("distDir: 'dist'");
  });
});
