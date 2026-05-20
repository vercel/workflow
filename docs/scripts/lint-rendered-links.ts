import { getTrustedSourcesHeaders } from '../../scripts/trusted-sources-headers.mjs';

const PAGE_PATHS = ['/', '/docs', '/worlds'];
const CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 15_000;

type LinkSource = {
  href: string;
  sourcePaths: string[];
};

type LinkError = {
  href: string;
  reason: string;
  sourcePath: string;
};

async function checkRenderedLinks() {
  const baseUrl = getBaseUrl();
  const linkSources = await collectRenderedPageLinks(baseUrl);
  const errors = await validateLinks(linkSources);

  if (errors.length > 0) {
    console.error('\nBroken rendered page links:');
    for (const error of errors) {
      console.error(`- ${error.sourcePath} -> ${error.href}: ${error.reason}`);
    }
    process.exit(1);
  }

  console.log(
    `Checked ${linkSources.length} internal rendered link${
      linkSources.length === 1 ? '' : 's'
    } across ${PAGE_PATHS.length} page${PAGE_PATHS.length === 1 ? '' : 's'}.`
  );
}

function getBaseUrl() {
  const rawBaseUrl =
    process.env.DOCS_LINK_BASE_URL || process.env.DEPLOYMENT_URL;
  if (!rawBaseUrl) {
    throw new Error(
      'Set DOCS_LINK_BASE_URL or DEPLOYMENT_URL to run rendered link checks.'
    );
  }

  const withProtocol = rawBaseUrl.startsWith('http')
    ? rawBaseUrl
    : `https://${rawBaseUrl}`;
  return withProtocol.endsWith('/') ? withProtocol : `${withProtocol}/`;
}

async function collectRenderedPageLinks(
  baseUrl: string
): Promise<LinkSource[]> {
  const linkSources = new Map<string, LinkSource>();
  const headers = await getTrustedSourcesHeaders();

  for (const path of PAGE_PATHS) {
    const pageUrl = new URL(path, baseUrl);
    const response = await fetchWithTimeout(pageUrl, { headers });

    if (!response.ok) {
      throw new Error(`Rendered page ${path} returned ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      throw new Error(`Rendered page ${path} content-type was ${contentType}`);
    }

    const html = await response.text();

    for (const href of getAnchorHrefs(html)) {
      const normalized = normalizeInternalHref(href, pageUrl);
      if (!normalized) continue;

      const existing = linkSources.get(normalized);
      if (existing) {
        existing.sourcePaths.push(path);
      } else {
        linkSources.set(normalized, { href: normalized, sourcePaths: [path] });
      }
    }
  }

  return [...linkSources.values()];
}

async function validateLinks(linkSources: LinkSource[]): Promise<LinkError[]> {
  const errors: LinkError[] = [];
  const headers = await getTrustedSourcesHeaders();

  await mapLimit(linkSources, CONCURRENCY, async (link) => {
    let response: Response;
    try {
      response = await fetchWithTimeout(link.href, { headers });
    } catch (error) {
      errors.push({
        href: link.href,
        sourcePath: link.sourcePaths.join(', '),
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!response.ok) {
      errors.push({
        href: link.href,
        sourcePath: link.sourcePaths.join(', '),
        reason: `returned ${response.status}`,
      });
    }
  });

  return errors;
}

async function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit
): Promise<Response> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return fetch(url, {
    ...init,
    redirect: 'follow',
    signal,
  });
}

function getAnchorHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const anchorHrefPattern =
    /<a\b[^>]*\bhref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

  let match = anchorHrefPattern.exec(html);
  while (match !== null) {
    hrefs.push(match[1] ?? match[2] ?? match[3] ?? '');
    match = anchorHrefPattern.exec(html);
  }

  return hrefs;
}

function normalizeInternalHref(href: string, pageUrl: URL): string | null {
  if (
    href === '' ||
    href.startsWith('#') ||
    href.startsWith('mailto:') ||
    href.startsWith('tel:')
  ) {
    return null;
  }

  const url = new URL(href, pageUrl);
  if (url.origin !== pageUrl.origin) {
    return null;
  }
  url.hash = '';
  return url.toString();
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
) {
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const promise = fn(item).finally(() => {
      executing.delete(promise);
    });
    executing.add(promise);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
}

void checkRenderedLinks();
