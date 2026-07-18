import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import { createDocsPage } from '@vercel/geistdocs/pages/docs';
import { Card, type CardProps } from 'fumadocs-ui/components/card';
import type { ComponentProps, ComponentType } from 'react';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { config } from '@/lib/geistdocs/config';
import { v5CookbookSource } from '@/lib/geistdocs/source';
import { rewriteHrefForVersion } from '@/lib/geistdocs/version-href';

const VERSION_PREFIX = '/v5';

// Content links are authored against the raw `/docs/...` and `/worlds/...`
// URL spaces; rewrite them into the v5 view so navigation doesn't escape to
// the v4 route. Card renders its own Link (not the `a` component), so it
// needs the same rewrite applied separately.
function v5Href<T>(href: T): T {
  return rewriteHrefForVersion(href, VERSION_PREFIX);
}

function V5CookbookCard(props: CardProps) {
  return <Card {...props} href={v5Href(props.href)} />;
}

const docsPage = createDocsPage({
  config: {
    ...config,
    github: config.github && {
      ...config.github,
      editPath: 'docs/content/docs/v5/{path}',
    },
  },
  source: v5CookbookSource,
  mdx: ({ link }) => getMDXComponents({ a: link, Card: V5CookbookCard }),
  resolveLink: ({ link }) => {
    const Link = link as ComponentType<ComponentProps<'a'>>;
    const V5CookbookLink = (props: ComponentProps<'a'>) => (
      <Link {...props} href={v5Href(props.href)} />
    );

    return V5CookbookLink;
  },
  openGraph: {
    images: true,
  },
  tableOfContentPopover: {
    enabled: false,
  },
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
  metadata: ({ metadata, page }) => {
    const stableUrl = page.url.replace(/^\/v5(?=\/cookbook(?:\/|$))/, '');

    return {
      ...metadata,
      title: `${page.data.title} · Pre-release`,
      alternates: {
        ...metadata.alternates,
        canonical: stableUrl,
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
