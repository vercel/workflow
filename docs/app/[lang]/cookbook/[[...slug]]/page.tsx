import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import { createDocsPage } from '@vercel/geistdocs/pages/docs';
import type { ComponentProps, ComponentType } from 'react';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { config } from '@/lib/geistdocs/config';
import { rewriteCookbookUrl } from '@/lib/geistdocs/cookbook-source';
import { cookbookSource } from '@/lib/geistdocs/source';

const docsPage = createDocsPage({
  config: {
    ...config,
    github: config.github && {
      ...config.github,
      editPath: 'docs/content/docs/v4/{path}',
    },
  },
  source: cookbookSource,
  mdx: ({ link }) => getMDXComponents({ a: link }),
  resolveLink: ({ link }) => {
    const Link = link as ComponentType<ComponentProps<'a'>>;
    const PublicCookbookLink = (props: ComponentProps<'a'>) => {
      const href =
        typeof props.href === 'string'
          ? rewriteCookbookUrl(props.href)
          : props.href;

      return <Link {...props} href={href} />;
    };

    return PublicCookbookLink;
  },
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
        'text/markdown':
          page.url === '/cookbook' ? '/cookbook.md' : `${page.url}.md`,
      },
    },
  }),
});

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
