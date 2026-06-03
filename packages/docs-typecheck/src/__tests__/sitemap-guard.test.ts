import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

const docsRequire = createRequire(path.join(repoRoot, 'docs/package.json'));

const listFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });

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

  it('keeps sitemap link in page-level markdown output', () => {
    const llmsRoute = read('docs/app/[lang]/llms.mdx/[[...slug]]/route.ts');
    const hasLocalSitemapLink = llmsRoute.includes('sitemap.md');
    const usesGeistdocsMarkdownRoute =
      llmsRoute.includes('@vercel/geistdocs/routes/llms') &&
      llmsRoute.includes('createDocsMarkdownRoute');

    if (hasLocalSitemapLink) {
      expect(llmsRoute).toContain('sitemap.md');
      return;
    }

    expect(usesGeistdocsMarkdownRoute).toBe(true);

    const geistdocsSourceEntry = docsRequire.resolve(
      '@vercel/geistdocs/source'
    );
    const geistdocsDist = path.dirname(geistdocsSourceEntry);
    const geistdocsFiles = listFiles(geistdocsDist).filter((file) =>
      /\.[cm]?js$/.test(file)
    );

    expect(
      geistdocsFiles.some((file) =>
        read(path.relative(repoRoot, file)).includes('/sitemap.md')
      )
    ).toBe(true);
  });
});
