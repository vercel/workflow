import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import {
  type FileObject,
  printErrors,
  scanURLs,
  validateFiles,
} from 'next-validate-link';
import { source } from '../lib/geistdocs/source';

const DOCS_DIR = fileURLToPath(new URL('..', import.meta.url));
const STATIC_APP_LINK_FILES = [
  'geistdocs.tsx',
  'app/[lang]/(home)/components/templates/index.tsx',
];
const KNOWN_APP_PATHS = new Set(['/', '/docs', '/cookbook', '/worlds']);

async function checkLinks() {
  // Pre-fetch all page content and headings
  const pages = await Promise.all(
    source.getPages().map(async (page) => {
      const raw = await page.data.getText('raw');
      return {
        page,
        hashes: getHeadingsFromMarkdown(raw),
      };
    })
  );

  const scanned = await scanURLs({
    preset: 'next',
    populate: {
      'docs/[[...slug]]': pages.map(({ page, hashes }) => ({
        value: {
          slug: page.slugs,
        },
        hashes,
      })),
    },
  });

  const errors = await validateFiles(await getFiles(), {
    scanned,
    markdown: {
      components: {
        Card: { attributes: ['href'] },
      },
    },
    checkRelativePaths: 'as-url',
  });

  printErrors(errors, true);

  await checkStaticAppLinks();
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

function getFiles() {
  const promises = source.getPages().map(
    async (page): Promise<FileObject> => ({
      path: page.absolutePath,
      content: await page.data.getText('raw'),
      url: page.url,
      data: page.data,
    })
  );
  return Promise.all(promises);
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
