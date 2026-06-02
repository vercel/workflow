import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import { createDocsPage } from '@vercel/geistdocs/pages/docs';
import type { ComponentProps, ComponentType } from 'react';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { config } from '@/lib/geistdocs/config';
import { rewriteCookbookUrlForVersion } from '@/lib/geistdocs/cookbook-source';
import { v5CookbookSource } from '@/lib/geistdocs/source';

const VERSION_PREFIX = '/v5';

const docsPage = createDocsPage({
  config,
  source: v5CookbookSource,
  mdx: ({ link }) => getMDXComponents({ a: link }),
  resolveLink: ({ link }) => {
    const Link = link as ComponentType<ComponentProps<'a'>>;
    const V5CookbookLink = (props: ComponentProps<'a'>) => {
      let href = props.href;

      if (typeof href === 'string') {
        href = rewriteCookbookUrlForVersion(href, VERSION_PREFIX);
        if (href.startsWith('/docs')) {
          href = `${VERSION_PREFIX}${href}`;
        }
      }

      return <Link {...props} href={href} />;
    };

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
