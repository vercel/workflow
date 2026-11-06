import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import { createDocsPage } from '@vercel/geistdocs/pages/docs';
import { Card, type CardProps } from 'fumadocs-ui/components/card';
import { permanentRedirect } from 'next/navigation';
import type { ComponentProps, ComponentType } from 'react';
import { AutoCards } from '@/components/geistdocs/auto-cards';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { config } from '@/lib/geistdocs/config';
import { rewriteCookbookUrl } from '@/lib/geistdocs/cookbook-source';
import { resolveSectionChildren } from '@/lib/geistdocs/section-children';
import { source, v4GeistdocsSource } from '@/lib/geistdocs/source';
import { rewriteHrefForVersion } from '@/lib/geistdocs/version-href';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { MAINTENANCE_VERSION } from '@/lib/geistdocs/versions';

const VERSION_PREFIX = '/v4';
const DEFAULT_LANG = config.defaultLanguage ?? 'en';

const getPageUrl = ({ page }: { page: { url: string } }) =>
  `${VERSION_PREFIX}${page.url}`;

// Content links are authored against the raw `/docs/...` and `/worlds/...`
// URL spaces; rewrite them into the v4 view so navigation doesn't escape to
// the current-version route. Card renders its own Link (not the `a`
// component), so it needs the same rewrite applied separately.
function v4Href<T>(href: T): T {
  return rewriteHrefForVersion(href, VERSION_PREFIX);
}

function V4Card(props: CardProps) {
  return <Card {...props} href={v4Href(props.href)} />;
}

const docsPage = createDocsPage({
  config: {
    ...config,
    github: config.github && {
      ...config.github,
      editPath: 'docs/content/docs/v4/{path}',
    },
  },
  source: v4GeistdocsSource,
  getPageUrl,
  mdx: ({ link, page }) =>
    getMDXComponents({
      a: link,
      Card: V4Card,
      // Cards render in the v4 URL space (`/v4/docs/...`), matching the
      // sidebar tree so hrefs don't escape to the current-version route.
      AutoCards: () => (
        <AutoCards
          items={resolveSectionChildren(
            getDocsTreeForVersion(DEFAULT_LANG, MAINTENANCE_VERSION),
            `${VERSION_PREFIX}${page.url}`
          )}
        />
      ),
    }),
  resolveLink: ({ link }) => {
    const Link = link as ComponentType<ComponentProps<'a'>>;
    const V4Link = (props: ComponentProps<'a'>) => (
      <Link {...props} href={v4Href(props.href)} />
    );

    return V4Link;
  },
  openGraph: {
    images: true,
  },
  tableOfContentPopover: {
    enabled: false,
  },
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
  metadata: ({ metadata, page, params }) => {
    const pageUrl = getPageUrl({ page });

    return {
      ...metadata,
      title: `${page.data.title} · v4`,
      alternates: {
        ...metadata.alternates,
        // Prefer the current-version page when the same path exists there so
        // search engines consolidate on the latest docs.
        canonical: source.getPage(params.slug, params.lang)
          ? page.url
          : pageUrl,
        types: {
          ...metadata.alternates?.types,
          'text/markdown': `${pageUrl}.md`,
        },
      },
      robots: {
        index: false,
        follow: true,
      },
    };
  },
});

const Page = async (props: PageProps<'/[lang]/v4/docs/[[...slug]]'>) => {
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
