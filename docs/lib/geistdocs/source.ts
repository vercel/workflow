import {
  createVersionedSources,
  type GeistdocsSourceBundle,
} from '@vercel/geistdocs/source';
import type { Node, Root } from 'fumadocs-core/page-tree';
import { v4docs, v5docs } from '@/.source/server';
import { config } from './config';
import { resolveSectionChildren } from './section-children';

type Source = GeistdocsSourceBundle['source'];
type Page = NonNullable<ReturnType<Source['getPage']>>;

const COOKBOOK_DOCS_PREFIX = '/docs/cookbook';
const DOCS_PREFIX = '/docs';
const LOCAL_DOCS_LINK_TARGET_RE =
  /(\]\(|\[[^\]\n]+\]:\s*|(?:href|src)=["'])(\/docs(?:[^\s)"']*)?)/g;

const hasPathPrefix = (url: string, prefix: string) =>
  url === prefix ||
  url.startsWith(`${prefix}/`) ||
  url.startsWith(`${prefix}#`) ||
  url.startsWith(`${prefix}?`);

const replacePathPrefix = (url: string, prefix: string, replacement: string) =>
  `${replacement}${url.slice(prefix.length)}`;

const rewriteLocalDocsUrlForVersion = (url: string, versionPrefix: string) => {
  if (hasPathPrefix(url, COOKBOOK_DOCS_PREFIX)) {
    return replacePathPrefix(
      url,
      COOKBOOK_DOCS_PREFIX,
      `${versionPrefix}/cookbook`
    );
  }

  if (versionPrefix && hasPathPrefix(url, DOCS_PREFIX)) {
    return replacePathPrefix(url, DOCS_PREFIX, `${versionPrefix}/docs`);
  }

  return url;
};

const rewriteCookbookUrlForVersion = (url: string, versionPrefix: string) =>
  rewriteLocalDocsUrlForVersion(url, versionPrefix);

const rewriteDocsUrlsForVersion = (text: string, versionPrefix: string) =>
  text.replace(LOCAL_DOCS_LINK_TARGET_RE, (_match, prefix, url) => {
    return `${prefix}${rewriteLocalDocsUrlForVersion(url, versionPrefix)}`;
  });

const isCookbookPage = (page: Pick<Page, 'url'>) =>
  page.url === '/docs/cookbook' || page.url.startsWith('/docs/cookbook/');

const withUrl = (page: Page, url: string): Page => ({ ...page, url });

// Matches the `<AutoCards />` placeholder (self-closing or paired) so the
// markdown export can substitute the rendered card list. The component itself
// only renders in the React tree, so without this the agent-facing markdown
// (llms.txt, .md routes, copy-page) would lose every child link.
const AUTO_CARDS_RE = /<AutoCards\b[^>]*?(?:\/>|>[\s\S]*?<\/AutoCards>)/g;

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const isCookbookFolder = (node: Node): boolean =>
  node.type === 'folder' &&
  (node.index?.url?.startsWith(COOKBOOK_DOCS_PREFIX) ?? false);

/**
 * Page tree for a version's markdown export: the version's own source tree
 * (raw `/docs/...` URL space, matching the pre-transform markdown) with
 * cookbook nodes stripped. Resolved lazily so the transform closures can
 * reference `versionedSources` after it is initialized.
 */
const getMarkdownTree = (versionId: 'v4' | 'v5'): Root => {
  const lang = config.defaultLanguage ?? 'en';
  const fullTree = versionedSources.byId[versionId].source.pageTree[lang];

  return {
    ...fullTree,
    children: fullTree.children.filter((node) => !isCookbookFolder(node)),
  };
};

/**
 * Render the `<Cards>`/`<Card>` JSX a section landing page would have
 * contained by hand, derived from the page tree. Matching the existing
 * serialized format keeps the markdown export consistent across converted and
 * unconverted pages. Runs before the version URL rewrite so the inserted
 * `href`s get mapped into the version's public URL space with everything else.
 */
const expandAutoCards = (
  markdown: string,
  versionId: 'v4' | 'v5',
  sectionUrl: string
): string =>
  // `.replace` is a no-op when there's no placeholder, and the replacer only
  // walks the tree on an actual match.
  markdown.replace(AUTO_CARDS_RE, () => {
    const cards = resolveSectionChildren(getMarkdownTree(versionId), sectionUrl)
      .map((child) => {
        const title = asText(child.title);
        const description = asText(child.description);
        const open = `<Card href="${child.url}" title="${title}">`;

        return description ? `${open}${description}</Card>` : `${open}</Card>`;
      })
      .join('\n');

    return `<Cards>\n${cards}\n</Cards>`;
  });

const versionedSources = createVersionedSources({
  config,
  current: 'v4',
  versions: [
    {
      id: 'v4',
      label: 'v4 (Latest)',
      docs: v4docs,
      baseUrl: '/docs',
      markdown: {
        transform: (markdown, { page }) =>
          rewriteDocsUrlsForVersion(
            expandAutoCards(markdown, 'v4', page.url),
            ''
          ),
      },
    },
    {
      id: 'v5',
      label: 'v5 (Pre-release)',
      docs: v5docs,
      baseUrl: '/docs',
      routePrefix: '/v5',
      markdown: {
        transform: (markdown, { page }) =>
          rewriteDocsUrlsForVersion(
            expandAutoCards(markdown, 'v5', page.url),
            '/v5'
          ),
      },
    },
  ],
});

const createDocsRouteSource = (
  bundle: GeistdocsSourceBundle,
  options: { id: string; label: string; versionPrefix?: string }
): GeistdocsSourceBundle => {
  const { id, label, versionPrefix = '' } = options;
  const baseSource = bundle.source;
  const mapPage = (page: Page) =>
    versionPrefix ? withUrl(page, `${versionPrefix}${page.url}`) : page;

  return {
    ...bundle,
    id,
    label,
    baseUrl: `${versionPrefix}/docs`,
    source: {
      ...baseSource,
      getPage: ((slug?: string[], lang?: string) => {
        if (slug?.[0] === 'cookbook') {
          return undefined;
        }

        return baseSource.getPage(slug, lang);
      }) as Source['getPage'],
      getPages: ((lang?: string) =>
        baseSource
          .getPages(lang)
          .filter((page) => !isCookbookPage(page))
          .map(mapPage)) as Source['getPages'],
      generateParams: ((...args: Parameters<Source['generateParams']>) =>
        baseSource
          .generateParams(...args)
          .filter(
            (params) =>
              !(Array.isArray(params.slug) && params.slug[0] === 'cookbook')
          )) as unknown as Source['generateParams'],
    },
  };
};

const resolveCookbookSlug = (slug?: string[]) => {
  if (!slug?.length) {
    return ['cookbook'];
  }

  return slug[0] === 'cookbook' ? slug : ['cookbook', ...slug];
};

const createCookbookRouteSource = (
  bundle: GeistdocsSourceBundle,
  options: { id: string; label: string; versionPrefix?: string }
): GeistdocsSourceBundle => {
  const { id, label, versionPrefix = '' } = options;
  const baseSource = bundle.source;
  const mapPage = (page: Page) =>
    withUrl(page, rewriteCookbookUrlForVersion(page.url, versionPrefix));

  return {
    ...bundle,
    id,
    label,
    baseUrl: `${versionPrefix}/cookbook`,
    source: {
      ...baseSource,
      getPage: ((slug?: string[], lang?: string) => {
        const page = baseSource.getPage(resolveCookbookSlug(slug), lang);

        return page && isCookbookPage(page) ? mapPage(page) : undefined;
      }) as Source['getPage'],
      getPages: ((lang?: string) =>
        baseSource
          .getPages(lang)
          .filter(isCookbookPage)
          .map(mapPage)) as Source['getPages'],
      generateParams: ((...args: Parameters<Source['generateParams']>) =>
        baseSource
          .generateParams(...args)
          .filter(
            (params) =>
              Array.isArray(params.slug) && params.slug[0] === 'cookbook'
          )
          .map((params) => ({
            ...params,
            slug: Array.isArray(params.slug)
              ? params.slug.slice(1)
              : params.slug,
          }))) as unknown as Source['generateParams'],
    },
  };
};

export const versions = versionedSources;

export const geistdocsSource = createDocsRouteSource(versionedSources.current, {
  id: 'docs',
  label: 'Docs',
});

export const cookbookSource = createCookbookRouteSource(
  versionedSources.current,
  {
    id: 'cookbook',
    label: 'Cookbook',
  }
);

export const v5GeistdocsSource = createDocsRouteSource(
  versionedSources.byId.v5,
  {
    id: 'v5-docs',
    label: 'v5 Docs',
    versionPrefix: '/v5',
  }
);

export const v5CookbookSource = createCookbookRouteSource(
  versionedSources.byId.v5,
  {
    id: 'v5-cookbook',
    label: 'v5 Cookbook',
    versionPrefix: '/v5',
  }
);

export const currentSources = [geistdocsSource, cookbookSource];
export const allSources = [
  geistdocsSource,
  cookbookSource,
  v5GeistdocsSource,
  v5CookbookSource,
];

export const source = versionedSources.current.source;
export const v5Source = versionedSources.byId.v5.source;
export const getPageImage = versionedSources.current.getPageImage;
export const getLLMText = versionedSources.current.getPageMarkdown;
