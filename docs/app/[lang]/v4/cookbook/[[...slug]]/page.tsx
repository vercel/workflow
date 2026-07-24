import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import { createDocsPage } from '@vercel/geistdocs/pages/docs';
import { Card, type CardProps } from 'fumadocs-ui/components/card';
import type { ComponentProps, ComponentType } from 'react';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { config } from '@/lib/geistdocs/config';
import { v4CookbookSource } from '@/lib/geistdocs/source';
import { rewriteHrefForVersion } from '@/lib/geistdocs/version-href';

const VERSION_PREFIX = '/v4';

// Content links are authored against the raw `/docs/...` and `/worlds/...`
// URL spaces; rewrite them into the v4 view so navigation doesn't escape to
// the current-version route. Card renders its own Link (not the `a`
// component), so it needs the same rewrite applied separately.
function v4Href<T>(href: T): T {
  return rewriteHrefForVersion(href, VERSION_PREFIX);
}

function V4CookbookCard(props: CardProps) {
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
  source: v4CookbookSource,
  mdx: ({ link }) => getMDXComponents({ a: link, Card: V4CookbookCard }),
  resolveLink: ({ link }) => {
    const Link = link as ComponentType<ComponentProps<'a'>>;
    const V4CookbookLink = (props: ComponentProps<'a'>) => (
      <Link {...props} href={v4Href(props.href)} />
    );

    return V4CookbookLink;
  },
  openGraph: {
    images: true,
  },
  tableOfContentPopover: {
    enabled: false,
  },
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
  metadata: ({ metadata, page }) => {
    const currentUrl = page.url.replace(/^\/v4(?=\/cookbook(?:\/|$))/, '');

    return {
      ...metadata,
      title: `${page.data.title} · v4`,
      alternates: {
        ...metadata.alternates,
        canonical: currentUrl,
        types: {
          ...metadata.alternates?.types,
          'text/markdown': `${page.url}.md`,
        },
      },
      robots: {
        index: false,
        follow: true,
      },
    };
  },
});

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
