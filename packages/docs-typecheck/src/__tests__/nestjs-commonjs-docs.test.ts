import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('NestJS docs stay aligned with supported module formats', () => {
  it('documents both ESM and CommonJS setup for @workflow/nest', () => {
    const guide = read('docs/content/docs/getting-started/nestjs.mdx');
    const readme = read('packages/nest/README.md');

    expect(readme).toContain("moduleType: 'commonjs'");
    expect(readme).toContain("distDir: 'dist'");

    expect(guide).toContain('### Choose Your Module Format');
    expect(guide).toContain('"type": "module"');
    expect(guide).toContain("moduleType: 'commonjs'");
    expect(guide).toContain("distDir: 'dist'");
  });
});
