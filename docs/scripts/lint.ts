import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import {
  type FileObject,
  printErrors,
  validateFiles,
} from 'next-validate-link';
import { rewriteCookbookUrl } from '../lib/geistdocs/cookbook-source';
import { source, v5Source } from '../lib/geistdocs/source';
import { getWorldIds } from '../lib/worlds-data';
import nextConfig from '../next.config';

const DOCS_DIR = fileURLToPath(new URL('..', import.meta.url));
const STATIC_APP_LINK_FILES = [
  'geistdocs.tsx',
  'app/[lang]/(home)/components/templates/index.tsx',
];
const KNOWN_APP_PATHS = new Set(['/', '/docs', '/cookbook', '/worlds']);

type UrlMeta = { hashes?: string[] };
type Scanned = {
  urls: Map<string, UrlMeta>;
  fallbackUrls: { url: RegExp; meta: UrlMeta }[];
};

type LoadedPage = {
  page: ReturnType<typeof source.getPages>[number];
  raw: string;
  hashes: string[];
};

async function loadPages(src: typeof source): Promise<LoadedPage[]> {
  return Promise.all(
    src.getPages().map(async (page) => {
      const raw = await page.data.getText('raw');
      return { page, raw, hashes: getHeadingsFromMarkdown(raw) };
    })
  );
}

/**
 * Static (non-fumadocs) routes that exist in the app for both versions:
 * the home page, section landing pages, worlds detail pages, and files
 * served from public/.
 */
async function getSharedUrls(): Promise<Map<string, UrlMeta>> {
  const urls = new Map<string, UrlMeta>();
  for (const path of [
    '/',
    '/docs',
    '/v5/docs',
    '/cookbook',
    '/v5/cookbook',
    '/worlds',
    '/worlds/compare',
    '/llms.txt',
    '/sitemap.md',
  ]) {
    urls.set(path, {});
  }
  for (const id of getWorldIds()) {
    urls.set(`/worlds/${id}`, {});
  }
  for (const asset of await listFilesRecursive(join(DOCS_DIR, 'public'))) {
    urls.set(`/${asset}`, {});
  }
  return urls;
}

async function listFilesRecursive(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(join(dir, entry.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Build the two URL spaces links are resolved against.
 *
 * v4 space — how hrefs resolve when rendered on a v4 (unversioned) page:
 *   /docs/X        → v4 page X
 *   /cookbook/X    → v4 cookbook page
 *   /v5/docs/X     → v5 page X (explicit cross-version link)
 *   /v5/cookbook/X → v5 cookbook page
 *
 * v5 space — how hrefs resolve when rendered on a /v5 page. The v5 routes
 * rewrite /docs/... hrefs (inline links and Card hrefs) to /v5/docs/... at
 * render time, so an unversioned /docs/X href on a v5 page resolves to the
 * v5 page X — it is broken unless X exists in the v5 content tree:
 *   /docs/X        → v5 page X (rewritten at render time)
 *   /cookbook/X    → v4 cookbook page (not rewritten)
 *   /v5/docs/X     → v5 page X
 *   /v5/cookbook/X → v5 cookbook page
 */
function buildSpaces(
  v4Pages: LoadedPage[],
  v5Pages: LoadedPage[],
  shared: Map<string, UrlMeta>
): { v4Space: Scanned; v5Space: Scanned } {
  const v4Space: Scanned = { urls: new Map(shared), fallbackUrls: [] };
  const v5Space: Scanned = { urls: new Map(shared), fallbackUrls: [] };

  for (const { page, hashes } of v4Pages) {
    const meta = { hashes };
    v4Space.urls.set(page.url, meta);
    const cookbookUrl = rewriteCookbookUrl(page.url);
    if (cookbookUrl !== page.url) {
      // /docs/cookbook/X is served at /cookbook/X — valid in both spaces
      // (cookbook links are not version-rewritten on v5 pages).
      v4Space.urls.set(cookbookUrl, meta);
      v5Space.urls.set(cookbookUrl, meta);
    }
  }

  for (const { page, hashes } of v5Pages) {
    const meta = { hashes };
    v4Space.urls.set(`/v5${page.url}`, meta);
    v5Space.urls.set(`/v5${page.url}`, meta);
    // On v5 pages, unversioned /docs/... hrefs are rewritten to /v5/docs/...
    // at render time, so they resolve to the v5 page.
    v5Space.urls.set(page.url, meta);
    const cookbookUrl = rewriteCookbookUrl(page.url);
    if (cookbookUrl !== page.url) {
      v4Space.urls.set(`/v5${cookbookUrl}`, meta);
      v5Space.urls.set(`/v5${cookbookUrl}`, meta);
    }
  }

  return { v4Space, v5Space };
}

/**
 * Mark next.config.ts redirect sources as valid wherever their destination
 * is valid. Parameterized sources (/a/:path*) are expanded against the
 * concrete URLs already in the space, so a redirect never blanket-validates
 * URLs whose destination doesn't exist.
 *
 * Sources under /docs are only reachable from v4 pages (on v5 pages the
 * render-time rewrite turns /docs/... into /v5/docs/..., which skips the
 * redirect), so they are only added to the v4 space.
 */
async function applyRedirects(v4Space: Scanned, v5Space: Scanned) {
  const redirects = (await nextConfig.redirects?.()) ?? [];

  for (const { source: src, destination: dest } of redirects) {
    if (src.includes(':') !== dest.includes(':')) continue;

    const spaces =
      src.startsWith('/docs') && !src.startsWith('/docs/cookbook')
        ? [v4Space]
        : [v4Space, v5Space];

    for (const space of spaces) {
      applyRedirectToSpace(space, src, dest);
    }
  }
}

function applyRedirectToSpace(space: Scanned, src: string, dest: string) {
  if (!src.includes(':')) {
    const meta = space.urls.get(dest);
    if (meta) space.urls.set(src, meta);
    return;
  }

  // Parameterized: both source and destination are a static prefix followed
  // by the same parameter (e.g. /docs/cookbook/:path* → /cookbook/:path*).
  // Expand by swapping prefixes against known URLs.
  const srcPrefix = src.slice(0, src.indexOf('/:'));
  const destPrefix = dest.slice(0, dest.indexOf('/:'));
  for (const [url, meta] of [...space.urls]) {
    if (url.startsWith(`${destPrefix}/`)) {
      space.urls.set(srcPrefix + url.slice(destPrefix.length), meta);
    }
  }
}

function getHeadingsFromMarkdown(content: string): string[] {
  const slugger = new GithubSlugger();
  const headingRegex = /^#{1,6}\s+(.+)$/gm;
  const headings: string[] = [];

  let match = headingRegex.exec(content);
  while (match !== null) {
    const headingText = match[1].trim();
    headings.push(slugger.slug(headingText));
    match = headingRegex.exec(content);
  }

  return headings;
}

function toFileObjects(pages: LoadedPage[]): FileObject[] {
  return pages.map(({ page, raw }) => ({
    path: page.absolutePath,
    content: raw,
    url: page.url,
    data: page.data,
  }));
}

/**
 * Extract `related` and `prerequisites` list entries from a page's raw
 * frontmatter.
 */
function getFrontmatterRefs(raw: string): string[] {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!frontmatter) return [];

  const refs: string[] = [];
  let inRefBlock = false;
  for (const line of frontmatter.split('\n')) {
    if (/^(related|prerequisites):\s*$/.test(line)) {
      inRefBlock = true;
      continue;
    }
    const item = inRefBlock && line.match(/^\s+-\s+(\/\S+)\s*$/);
    if (item) {
      refs.push(item[1]);
    } else if (!/^\s/.test(line)) {
      inRefBlock = false;
    }
  }
  return refs;
}

/**
 * Validate frontmatter `related` and `prerequisites` references. These are
 * version-relative: a /docs/... reference on a v5 page must exist in the v5
 * content tree (matching how the page's links resolve when rendered).
 */
function checkFrontmatterRefs(
  pages: LoadedPage[],
  space: Scanned,
  errors: { href: string; reason: string; sourcePath: string }[]
) {
  for (const { page, raw } of pages) {
    for (const ref of getFrontmatterRefs(raw)) {
      const [pathname, fragment] = ref.split('#', 2);
      const meta = space.urls.get(pathname.replace(/\/$/, '') || '/');
      if (!meta) {
        errors.push({
          href: ref,
          sourcePath: page.absolutePath,
          reason: 'not found',
        });
      } else if (fragment && meta.hashes && !meta.hashes.includes(fragment)) {
        errors.push({
          href: ref,
          sourcePath: page.absolutePath,
          reason: `heading #${fragment} not found`,
        });
      }
    }
  }
}

async function checkLinks() {
  const [v4Pages, v5Pages, shared] = await Promise.all([
    loadPages(source),
    loadPages(v5Source),
    getSharedUrls(),
  ]);

  const { v4Space, v5Space } = buildSpaces(v4Pages, v5Pages, shared);
  await applyRedirects(v4Space, v5Space);

  const markdown = {
    components: {
      Card: { attributes: ['href'] },
    },
  };

  const [v4Errors, v5Errors] = await Promise.all([
    validateFiles(toFileObjects(v4Pages), {
      scanned: v4Space,
      markdown,
      checkRelativePaths: 'as-url',
    }),
    validateFiles(toFileObjects(v5Pages), {
      scanned: v5Space,
      markdown,
      checkRelativePaths: 'as-url',
    }),
  ]);

  printErrors([...v4Errors, ...v5Errors], true);

  const frontmatterErrors: {
    href: string;
    reason: string;
    sourcePath: string;
  }[] = [];
  checkFrontmatterRefs(v4Pages, v4Space, frontmatterErrors);
  checkFrontmatterRefs(v5Pages, v5Space, frontmatterErrors);

  if (frontmatterErrors.length > 0) {
    console.error('\nBroken frontmatter references:');
    for (const error of frontmatterErrors) {
      console.error(`- ${error.sourcePath} -> ${error.href}: ${error.reason}`);
    }
    process.exitCode = 1;
  }

  await checkStaticAppLinks();
}

async function checkStaticAppLinks() {
  const errors: { href: string; reason: string; sourcePath: string }[] = [];

  for (const sourcePath of STATIC_APP_LINK_FILES) {
    const content = await readFile(join(DOCS_DIR, sourcePath), 'utf8');
    for (const href of getInternalHrefLiterals(content)) {
      if (!isKnownInternalPath(href)) {
        errors.push({
          href,
          sourcePath,
          reason: 'no matching docs source page or app route',
        });
      }
    }
  }

  if (errors.length > 0) {
    console.error('\nBroken app source links:');
    for (const error of errors) {
      console.error(`- ${error.sourcePath} -> ${error.href}: ${error.reason}`);
    }
    process.exitCode = 1;
  }
}

function getInternalHrefLiterals(content: string): string[] {
  const hrefs: string[] = [];
  const hrefPattern =
    /\b(?:href|link)\s*(?:=|:)\s*(['"`])(\/(?!\/)[^'"`]*?)\1/g;

  let match = hrefPattern.exec(content);
  while (match !== null) {
    hrefs.push(match[2]);
    match = hrefPattern.exec(content);
  }

  return hrefs;
}

function isKnownInternalPath(href: string) {
  const url = new URL(href, 'https://workflow-sdk.dev');
  const pathname = normalizePathname(url.pathname);

  return (
    KNOWN_APP_PATHS.has(pathname) ||
    source.getPageByHref(pathname) !== undefined
  );
}

function normalizePathname(pathname: string) {
  return pathname.replace(/\/$/, '') || '/';
}

void checkLinks();
