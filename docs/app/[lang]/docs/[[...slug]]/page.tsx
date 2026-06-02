import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import { createDocsPage } from '@vercel/geistdocs/pages/docs';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { config } from '@/lib/geistdocs/config';
import { geistdocsSource } from '@/lib/geistdocs/source';

const docsPage = createDocsPage({
  config,
  source: geistdocsSource,
  mdx: ({ link }) => getMDXComponents({ a: link }),
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

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
