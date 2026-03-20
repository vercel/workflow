import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('@workflow/docs-typecheck README stays aligned with runner behavior', () => {
  it('documents that TypeScript samples are the ones currently type-checked', () => {
    const readme = read('packages/docs-typecheck/README.md');

    expect(readme).toContain(
      'Within those files, fenced `ts` / `typescript` samples are type-checked exactly as written.'
    );
    expect(readme).toContain(
      'Fenced `js` / `javascript` samples are currently extracted by the parser, but they are not part of the verification pass yet.'
    );
  });
});
