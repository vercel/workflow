import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Folder, Node, Root } from 'fumadocs-core/page-tree';
import GithubSlugger from 'github-slugger';
import {
  type FileObject,
  printErrors,
  validateFiles,
} from 'next-validate-link';
import {
  getDocsTreeWithoutCookbook,
  rewriteCookbookUrl,
} from '../lib/geistdocs/cookbook-source';
import { resolveSectionChildren } from '../lib/geistdocs/section-children';
import {
  source,
  v5Source,
  v5WorldsSource,
  worldsSource,
} from '../lib/geistdocs/source';
import { getWorldIds } from '../lib/worlds-data';
import nextConfig from '../next.config';

const DOCS_DIR = fileURLToPath(new URL('..', import.meta.url));
const STATIC_APP_LINK_FILES = [
  'geistdocs.tsx',
  'app/[lang]/(home)/components/templates/index.tsx',
  'app/[lang]/worlds/page.tsx',
];
const KNOWN_APP_PATHS = new Set(['/', '/docs', '/cookbook', '/worlds']);

type UrlMeta = { hashes?: string[] };
type Scanned = {
  urls: Map<string, UrlMeta>;
  fallbackUrls: { url: RegExp; meta: UrlMeta }[];
};

// The geistdocs source bundle erases the collection's frontmatter/runtime
// typing, so restore the fields the lint relies on structurally.
type RawDocsPage = ReturnType<typeof source.getPages>[number] & {
  absolutePath: string;
  data: ReturnType<typeof source.getPages>[number]['data'] & {
    getText(kind: 'raw'): Promise<string>;
  };
};

type LoadedPage = {
  page: RawDocsPage;
  raw: string;
  hashes: string[];
};

async function loadPages(src: typeof source): Promise<LoadedPage[]> {
  return Promise.all(
    (src.getPages() as RawDocsPage[]).map(async (page) => {
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
  worldsV4Pages: LoadedPage[],
  worldsV5Pages: LoadedPage[],
  shared: Map<string, UrlMeta>
): { v4Space: Scanned; v5Space: Scanned } {
  const v4Space: Scanned = { urls: new Map(shared), fallbackUrls: [] };
  const v5Space: Scanned = { urls: new Map(shared), fallbackUrls: [] };

  // World docs are versioned like the docs trees and rendered at /worlds/*
  // (v4/current) and /v5/worlds/* (pre-release). They follow the same URL
  // resolution model: on v5 pages, unversioned /worlds/... hrefs are
  // rewritten to /v5/worlds/... at render time. Unlike the manifest-derived
  // entries in getSharedUrls, these carry heading hashes.
  for (const { page, hashes } of worldsV4Pages) {
    v4Space.urls.set(page.url, { hashes });
  }
  for (const { page, hashes } of worldsV5Pages) {
    const meta = { hashes };
    v4Space.urls.set(`/v5${page.url}`, meta);
    v5Space.urls.set(`/v5${page.url}`, meta);
    v5Space.urls.set(page.url, meta);
  }

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
  const [v4Pages, v5Pages, worldsV4Pages, worldsV5Pages, shared] =
    await Promise.all([
      loadPages(source),
      loadPages(v5Source),
      loadPages(worldsSource),
      loadPages(v5WorldsSource),
      getSharedUrls(),
    ]);

  const { v4Space, v5Space } = buildSpaces(
    v4Pages,
    v5Pages,
    worldsV4Pages,
    worldsV5Pages,
    shared
  );
  await applyRedirects(v4Space, v5Space);

  const markdown = {
    components: {
      Card: { attributes: ['href'] },
    },
  };

  const [v4Errors, v5Errors, worldsV4Errors, worldsV5Errors] =
    await Promise.all([
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
      // World pages resolve links version-relative, exactly like docs pages:
      // v4 world pages against the v4 space, v5 world pages against the v5
      // space (where unversioned /docs and /worlds hrefs are render-rewritten
      // into the /v5 view).
      validateFiles(toFileObjects(worldsV4Pages), {
        scanned: v4Space,
        markdown,
        checkRelativePaths: 'as-url',
      }),
      validateFiles(toFileObjects(worldsV5Pages), {
        scanned: v5Space,
        markdown,
        checkRelativePaths: 'as-url',
      }),
    ]);

  printErrors(
    [...v4Errors, ...v5Errors, ...worldsV4Errors, ...worldsV5Errors],
    true
  );

  const frontmatterErrors: {
    href: string;
    reason: string;
    sourcePath: string;
  }[] = [];
  checkFrontmatterRefs(v4Pages, v4Space, frontmatterErrors);
  checkFrontmatterRefs(v5Pages, v5Space, frontmatterErrors);
  checkFrontmatterRefs(worldsV4Pages, v4Space, frontmatterErrors);
  checkFrontmatterRefs(worldsV5Pages, v5Space, frontmatterErrors);

  if (frontmatterErrors.length > 0) {
    console.error('\nBroken frontmatter references:');
    for (const error of frontmatterErrors) {
      console.error(`- ${error.sourcePath} -> ${error.href}: ${error.reason}`);
    }
    process.exitCode = 1;
  }

  await checkStaticAppLinks();
  checkSectionCards(v4Pages, v5Pages);
  await checkMetaEntriesResolve();
}

/**
 * Enforce that every section landing page accounts for all of its navigation
 * children. A page passes if it either:
 *   - renders `<AutoCards />` (cards are derived from the tree — drift is
 *     structurally impossible), or
 *   - declares `manualCards: true` in frontmatter (intentionally curated), or
 *   - has a `<Card href>` for every child page in the section.
 *
 * The existing link validation already covers the reverse direction (cards that
 * point at pages which don't exist), so together the two checks keep the card
 * grid and the sidebar in lockstep.
 */
function sectionMissingCards(
  folder: Folder,
  tree: Root,
  rawByUrl: Map<string, LoadedPage>
): { sourcePath: string; missing: string[] } | null {
  const sectionUrl = folder.index?.url;
  if (!sectionUrl) return null;

  const expected = resolveSectionChildren(tree, sectionUrl).map((c) =>
    normalizePathname(c.url)
  );
  if (expected.length === 0) return null;

  const loaded = rawByUrl.get(sectionUrl);
  if (!loaded) return null;
  const { raw, page } = loaded;

  // Drift is impossible (AutoCards) or intentionally owned by the author.
  if (/<AutoCards\b/.test(raw) || hasManualCardsFlag(raw)) return null;

  const carded = new Set(
    getCardHrefs(raw).map((href) => normalizePathname(href))
  );
  const missing = expected.filter((url) => !carded.has(url));
  return missing.length > 0 ? { sourcePath: page.absolutePath, missing } : null;
}

function checkSectionCards(v4Pages: LoadedPage[], v5Pages: LoadedPage[]) {
  const errors: { sourcePath: string; missing: string[] }[] = [];
  for (const [pages, version] of [
    [v4Pages, 'v4'],
    [v5Pages, 'v5'],
  ] as const) {
    const tree = getDocsTreeWithoutCookbook('en', version);
    const rawByUrl = new Map(pages.map((p) => [p.page.url, p]));
    for (const folder of collectSectionFolders(tree.children)) {
      const result = sectionMissingCards(folder, tree, rawByUrl);
      if (result) errors.push(result);
    }
  }

  if (errors.length > 0) {
    console.error(
      '\nSection landing pages missing cards for navigation children:'
    );
    for (const error of errors) {
      console.error(`- ${error.sourcePath}: ${error.missing.join(', ')}`);
    }
    console.error(
      '  Fix by using <AutoCards /> (recommended), adding the missing <Card> ' +
        'entries, or setting `manualCards: true` if the page is intentionally curated.'
    );
    process.exitCode = 1;
  }
}

/** Recursively collect folders that have an index page (section landing pages). */
function collectSectionFolders(nodes: Node[]): Folder[] {
  const folders: Folder[] = [];
  for (const node of nodes) {
    if (node.type !== 'folder') continue;
    if (node.index) folders.push(node);
    folders.push(...collectSectionFolders(node.children));
  }
  return folders;
}

function getCardHrefs(raw: string): string[] {
  const hrefs: string[] = [];
  const pattern = /<Card\b[^>]*?\bhref="([^"]+)"/g;
  let match = pattern.exec(raw);
  while (match !== null) {
    hrefs.push(match[1].split('#')[0]);
    match = pattern.exec(raw);
  }
  return hrefs;
}

function hasManualCardsFlag(raw: string): boolean {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
  return frontmatter ? /^manualCards:\s*true\s*$/m.test(frontmatter) : false;
}

/**
 * Validate that every plain-slug `pages` entry in a `meta.json` resolves to a
 * real page file or sub-folder. Catches dangling navigation entries (e.g. a
 * `cancellation` entry with no `cancellation.mdx`). Fumadocs control tokens
 * (`...rest`, `---separators---`, `[label](url)` links, `!exclude`) are skipped.
 */
// Fumadocs control tokens that don't reference a page: rest globs, separators,
// external links, and exclusions.
function isMetaControlToken(entry: string): boolean {
  return (
    entry === 'index' ||
    entry.startsWith('...') ||
    entry.startsWith('---') ||
    entry.startsWith('[') ||
    entry.startsWith('!')
  );
}

async function metaEntryResolves(dir: string, entry: string): Promise<boolean> {
  return (
    (await pathExists(join(dir, `${entry}.mdx`))) ||
    (await pathExists(join(dir, `${entry}.md`))) ||
    (await pathExists(join(dir, entry)))
  );
}

async function unresolvedMetaEntries(metaPath: string): Promise<string[]> {
  let pages: unknown;
  try {
    pages = JSON.parse(await readFile(metaPath, 'utf8')).pages;
  } catch {
    return [];
  }
  if (!Array.isArray(pages)) return [];

  const dir = metaPath.slice(0, metaPath.lastIndexOf('/'));
  const unresolved: string[] = [];
  for (const entry of pages) {
    if (typeof entry !== 'string' || isMetaControlToken(entry)) continue;
    if (!(await metaEntryResolves(dir, entry))) unresolved.push(entry);
  }
  return unresolved;
}

async function checkMetaEntriesResolve() {
  const errors: { sourcePath: string; entry: string }[] = [];
  const contentRoots = [
    join(DOCS_DIR, 'content/docs'),
    join(DOCS_DIR, 'content/worlds'),
  ];

  for (const contentRoot of contentRoots) {
    for (const metaPath of await findFiles(contentRoot, 'meta.json')) {
      for (const entry of await unresolvedMetaEntries(metaPath)) {
        errors.push({ sourcePath: metaPath, entry });
      }
    }
  }

  if (errors.length > 0) {
    console.error('\nmeta.json entries with no matching page or folder:');
    for (const error of errors) {
      console.error(`- ${error.sourcePath} -> "${error.entry}"`);
    }
    process.exitCode = 1;
  }
}

async function findFiles(dir: string, name: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findFiles(full, name)));
    } else if (entry.name === name) {
      out.push(full);
    }
  }
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
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
    source.getPageByHref(pathname) !== undefined ||
    worldsSource.getPageByHref(pathname) !== undefined
  );
}

function normalizePathname(pathname: string) {
  return pathname.replace(/\/$/, '') || '/';
}

void checkLinks();
