import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
  v4Source,
  v4WorldsSource,
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
const KNOWN_APP_PATHS = new Set([
  '/',
  '/changelog',
  '/cookbook',
  '/docs',
  '/worlds',
]);

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
    '/v4/docs',
    '/cookbook',
    '/v4/cookbook',
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
 * v5 space — how hrefs resolve when rendered on a v5 (unversioned, current)
 * page:
 *   /docs/X        → v5 page X
 *   /cookbook/X    → v5 cookbook page
 *   /v4/docs/X     → v4 page X (explicit cross-version link)
 *   /v4/cookbook/X → v4 cookbook page
 *
 * v4 space — how hrefs resolve when rendered on a /v4 page. The v4 routes
 * rewrite /docs/... hrefs (inline links and Card hrefs) to /v4/docs/... at
 * render time, so an unversioned /docs/X href on a v4 page resolves to the
 * v4 page X — it is broken unless X exists in the v4 content tree:
 *   /docs/X        → v4 page X (rewritten at render time)
 *   /cookbook/X    → v5 cookbook page (not rewritten)
 *   /v4/docs/X     → v4 page X
 *   /v4/cookbook/X → v4 cookbook page
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
  // (v5/current) and /v4/worlds/* (maintenance). They follow the same URL
  // resolution model: on v4 pages, unversioned /worlds/... hrefs are
  // rewritten to /v4/worlds/... at render time. Unlike the manifest-derived
  // entries in getSharedUrls, these carry heading hashes.
  for (const { page, hashes } of worldsV5Pages) {
    v5Space.urls.set(page.url, { hashes });
  }
  for (const { page, hashes } of worldsV4Pages) {
    const meta = { hashes };
    v5Space.urls.set(`/v4${page.url}`, meta);
    v4Space.urls.set(`/v4${page.url}`, meta);
    v4Space.urls.set(page.url, meta);
  }

  for (const { page, hashes } of v5Pages) {
    const meta = { hashes };
    v5Space.urls.set(page.url, meta);
    const cookbookUrl = rewriteCookbookUrl(page.url);
    if (cookbookUrl !== page.url) {
      // /docs/cookbook/X is served at /cookbook/X — valid in both spaces
      // (cookbook links are not version-rewritten on v4 pages).
      v5Space.urls.set(cookbookUrl, meta);
      v4Space.urls.set(cookbookUrl, meta);
    }
  }

  for (const { page, hashes } of v4Pages) {
    const meta = { hashes };
    v5Space.urls.set(`/v4${page.url}`, meta);
    v4Space.urls.set(`/v4${page.url}`, meta);
    // On v4 pages, unversioned /docs/... hrefs are rewritten to /v4/docs/...
    // at render time, so they resolve to the v4 page.
    v4Space.urls.set(page.url, meta);
    const cookbookUrl = rewriteCookbookUrl(page.url);
    if (cookbookUrl !== page.url) {
      v5Space.urls.set(`/v4${cookbookUrl}`, meta);
      v4Space.urls.set(`/v4${cookbookUrl}`, meta);
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
 * Destinations are resolved against the v5 space, which is the real HTTP URL
 * space (unprefixed URLs are served by the current version, /v4 ones by the
 * maintenance version). Redirects are matched by the server before a page
 * renders, so the render-time /docs → /v4/docs href rewriting never applies
 * to them — a /v5/... link on a v4 page still lands on the v5 page.
 *
 * Sources under /docs are only reachable from v5 pages (on v4 pages the
 * render-time rewrite turns /docs/... into /v4/docs/..., which skips the
 * redirect), so they are only added to the v5 space.
 */
async function applyRedirects(v4Space: Scanned, v5Space: Scanned) {
  const resolvedConfig = await nextConfig;
  const redirects = (await resolvedConfig.redirects?.()) ?? [];

  for (const { source: src, destination: dest } of redirects) {
    if (src.includes(':') !== dest.includes(':')) continue;

    const spaces =
      src.startsWith('/docs') && !src.startsWith('/docs/cookbook')
        ? [v5Space]
        : [v4Space, v5Space];

    for (const space of spaces) {
      applyRedirectToSpace(space, src, dest, v5Space);
    }
  }
}

function applyRedirectToSpace(
  space: Scanned,
  src: string,
  dest: string,
  httpSpace: Scanned
) {
  if (!src.includes(':')) {
    const meta = httpSpace.urls.get(dest);
    if (meta) space.urls.set(src, meta);
    return;
  }

  // Parameterized: both source and destination are a static prefix followed
  // by the same parameter (e.g. /docs/cookbook/:path* → /cookbook/:path*).
  // Expand by swapping prefixes against known URLs.
  const srcPrefix = src.slice(0, src.indexOf('/:'));
  const destPrefix = dest.slice(0, dest.indexOf('/:'));
  for (const [url, meta] of [...httpSpace.urls]) {
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
 * version-relative: a /docs/... reference on a v4 page must exist in the v4
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
      loadPages(v4Source),
      loadPages(source),
      loadPages(v4WorldsSource),
      loadPages(worldsSource),
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
      // v5 world pages against the v5 space, v4 world pages against the v4
      // space (where unversioned /docs and /worlds hrefs are render-rewritten
      // into the /v4 view).
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
  await checkPublicSiteContent([
    ...v4Pages,
    ...v5Pages,
    ...worldsV4Pages,
    ...worldsV5Pages,
  ]);
}

/**
 * The docs site is public and user-facing (see AGENTS.md, "The docs site is
 * public"). Keep maintainer material off it:
 *   - no `changelog/` section in the docs trees. Release notes come from the
 *     packages' CHANGELOG.md at `/changelog`, and design notes live as
 *     markdown next to the code they describe. Docs pages link neither to the
 *     old `/docs/changelog` URLs nor to those notes on GitHub;
 *   - every page under an `internal/` folder declares `internal: true`, which
 *     makes it preview-only (see `lib/geistdocs/visibility.ts`);
 *   - a public page never links to an internal one, which 404s in production.
 */
async function checkPublicSiteContent(pages: LoadedPage[]) {
  const errors: { sourcePath: string; reason: string }[] = [];

  for (const contentRoot of ['content/docs', 'content/worlds']) {
    for (const dir of await findDirs(
      join(DOCS_DIR, contentRoot),
      'changelog'
    )) {
      errors.push({
        sourcePath: relative(DOCS_DIR, dir),
        reason:
          'docs trees have no changelog section: put design notes next to the code they describe, and release notes in a changeset',
      });
    }
  }

  const internalUrls = new Set(
    pages.filter(isInternalPage).map(({ page }) => stripVersion(page.url))
  );
  for (const loaded of pages) {
    for (const reason of publicSiteViolations(loaded, internalUrls)) {
      errors.push({ sourcePath: loaded.page.absolutePath, reason });
    }
  }

  if (errors.length > 0) {
    console.error('\nMaintainer-only content on the public docs site:');
    for (const error of errors) {
      console.error(`- ${error.sourcePath}: ${error.reason}`);
    }
    process.exitCode = 1;
  }
}

function publicSiteViolations(
  loaded: LoadedPage,
  internalUrls: Set<string>
): string[] {
  const reasons: string[] = [];
  const internal = isInternalPage(loaded);
  if (/[\\/]internal[\\/]/.test(loaded.page.absolutePath) && !internal) {
    reasons.push('pages under internal/ must set `internal: true` frontmatter');
  }
  for (const href of getSitePathHrefs(loaded.raw)) {
    const path = stripVersion(href.replace(/\.md$/, ''));
    if (/^\/docs\/changelog(\/|$)/.test(path)) {
      reasons.push(
        `${href}: the docs changelog section was retired (design notes live next to the code)`
      );
    } else if (!internal && internalUrls.has(path)) {
      reasons.push(`${href}: links to an internal (preview-only) page`);
    }
  }
  for (const [href] of loaded.raw.matchAll(DESIGN_NOTE_LINK_RE)) {
    reasons.push(
      `${href}: docs pages do not link to design notes in the repository`
    );
  }
  return reasons;
}

// A markdown file under `packages/` on GitHub: a design note or a package
// README's internals, not something a docs reader acts on.
const DESIGN_NOTE_LINK_RE =
  /https:\/\/github\.com\/vercel\/workflow\/blob\/[^/\s)]+\/packages\/[^\s)#"']+\.md\b/g;

// Frontmatter is read from the raw source, as for `manualCards`: the lint's
// page data does not carry it.
function isInternalPage({ raw }: LoadedPage): boolean {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
  return frontmatter ? /^internal:\s*true\s*$/m.test(frontmatter) : false;
}

function stripVersion(url: string): string {
  return url.replace(/^\/v4(?=\/)/, '');
}

/** Site-relative link targets (`/docs/...`, `/v4/...`, `/worlds/...`), path only. */
function getSitePathHrefs(raw: string): string[] {
  const hrefs: string[] = [];
  const re =
    /(?:\]\(|\[[^\]\n]+\]:\s*|(?:href|src)=["'])(\/(?:v4\/)?(?:docs|worlds)[^\s)"'#?]*)/g;
  for (const match of raw.matchAll(re)) hrefs.push(match[1]);
  return hrefs;
}

async function findDirs(dir: string, name: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name === name) out.push(full);
    out.push(...(await findDirs(full, name)));
  }
  return out;
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
