import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import { createDocsPage } from '@vercel/geistdocs/pages/docs';
import { permanentRedirect } from 'next/navigation';
import { AutoCards } from '@/components/geistdocs/auto-cards';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { config } from '@/lib/geistdocs/config';
import { rewriteCookbookUrl } from '@/lib/geistdocs/cookbook-source';
import { resolveSectionChildren } from '@/lib/geistdocs/section-children';
import { geistdocsSource } from '@/lib/geistdocs/source';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { LATEST_VERSION } from '@/lib/geistdocs/versions';

const DEFAULT_LANG = config.defaultLanguage ?? 'en';

const docsPage = createDocsPage({
  config: {
    ...config,
    github: config.github && {
      ...config.github,
      editPath: 'docs/content/docs/v4/{path}',
    },
  },
  source: geistdocsSource,
  mdx: ({ link, page }) =>
    getMDXComponents({
      a: link,
      // Section landing pages render their child cards from the page tree
      // (same tree that drives the sidebar), so the grid can never drift from
      // the navigation. See `resolveSectionChildren`.
      AutoCards: () => (
        <AutoCards
          items={resolveSectionChildren(
            getDocsTreeForVersion(DEFAULT_LANG, LATEST_VERSION),
            page.url
          )}
        />
      ),
    }),
  openGraph: {
    images: true,
  },
  tableOfContentPopover: {
    enabled: false,
  },
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
  metadata: ({ metadata, page }) => ({
    ...metadata,
    alternates: {
      ...metadata.alternates,
      canonical: page.url,
      types: {
        ...metadata.alternates?.types,
        'text/markdown': page.url === '/docs' ? '/docs.md' : `${page.url}.md`,
      },
    },
  }),
});

const Page = async (props: PageProps<'/[lang]/docs/[[...slug]]'>) => {
  const { slug, lang } = await props.params;

  // Cookbook recipes moved out of `/docs/cookbook/...` into their own
  // `/cookbook/...` URL space; permanently redirect legacy deep links.
  if (Array.isArray(slug) && slug[0] === 'cookbook') {
    const rest = slug.slice(1).join('/');
    const legacyPath = `/docs/cookbook${rest ? `/${rest}` : ''}`;
    permanentRedirect(`/${lang}${rewriteCookbookUrl(legacyPath)}`);
  }

  return docsPage.Page(props);
};

export default Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
