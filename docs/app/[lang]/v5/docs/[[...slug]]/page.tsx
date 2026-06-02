import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import { createDocsPage } from '@vercel/geistdocs/pages/docs';
import type { ComponentProps, ComponentType } from 'react';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { config } from '@/lib/geistdocs/config';
import { rewriteCookbookUrlForVersion } from '@/lib/geistdocs/cookbook-source';
import { source, v5GeistdocsSource } from '@/lib/geistdocs/source';

const VERSION_PREFIX = '/v5';

const getPageUrl = ({ page }: { page: { url: string } }) =>
  `${VERSION_PREFIX}${page.url}`;

const docsPage = createDocsPage({
  config,
  source: v5GeistdocsSource,
  getPageUrl,
  mdx: ({ link }) => getMDXComponents({ a: link }),
  resolveLink: ({ link }) => {
    const Link = link as ComponentType<ComponentProps<'a'>>;
    const V5Link = (props: ComponentProps<'a'>) => {
      let href = props.href;

      if (typeof href === 'string') {
        href = rewriteCookbookUrlForVersion(href, VERSION_PREFIX);
        if (href.startsWith('/docs')) {
          href = `${VERSION_PREFIX}${href}`;
        }
      }

      return <Link {...props} href={href} />;
    };

    return V5Link;
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
      title: `${page.data.title} · Pre-release`,
      alternates: {
        ...metadata.alternates,
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

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
