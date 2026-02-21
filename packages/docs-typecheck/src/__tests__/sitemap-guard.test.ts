import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

describe('Docs sitemap guard', () => {
  it('keeps sitemap markdown routes', () => {
    const rootSitemap = path.join(repoRoot, 'docs/app/sitemap.md/route.ts');
    const localizedSitemap = path.join(
      repoRoot,
      'docs/app/[lang]/sitemap.md/route.ts'
    );

    expect(fs.existsSync(rootSitemap)).toBe(true);
    expect(fs.existsSync(localizedSitemap)).toBe(true);
  });

  it('keeps sitemap link in llms markdown route', () => {
    const llmsRoute = read('docs/app/[lang]/llms.mdx/[[...slug]]/route.ts');

    expect(llmsRoute).toContain('## Sitemap');
    expect(llmsRoute).toContain('sitemap.md');
  });
});
