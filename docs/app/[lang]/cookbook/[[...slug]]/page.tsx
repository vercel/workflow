import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ComponentProps } from 'react';
import {
  rewriteCookbookUrl,
  rewriteCookbookUrlsInText,
} from '@/lib/geistdocs/cookbook-source';
import { MobileDocsBar } from '@/components/geistdocs/mobile-docs-bar';
import { AskAI } from '@/components/geistdocs/ask-ai';
import { CopyPage } from '@/components/geistdocs/copy-page';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from '@/components/geistdocs/docs-page';
import { EditSource } from '@/components/geistdocs/edit-source';
import { Feedback } from '@/components/geistdocs/feedback';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { OpenInChat } from '@/components/geistdocs/open-in-chat';
import { ScrollTop } from '@/components/geistdocs/scroll-top';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { getLLMText, getPageImage, source } from '@/lib/geistdocs/source';

const Page = async ({ params }: PageProps<'/[lang]/cookbook/[[...slug]]'>) => {
  const { slug, lang } = await params;

  // Prepend 'cookbook' to resolve from the docs source
  const resolvedSlug = slug ? ['cookbook', ...slug] : ['cookbook'];
  const page = source.getPage(resolvedSlug, lang);

  if (!page) {
    notFound();
  }

  const publicUrl = rewriteCookbookUrl(page.url);
  const publicPage = { ...page, url: publicUrl } as typeof page;

  const markdown = rewriteCookbookUrlsInText(await getLLMText(page));
  const MDX = page.data.body;

  const RelativeLink = createRelativeLink(source, publicPage);
  const PublicCookbookLink = (props: ComponentProps<typeof RelativeLink>) => {
    const href =
      typeof props.href === 'string'
        ? rewriteCookbookUrl(props.href)
        : props.href;
    return <RelativeLink {...props} href={href} />;
  };

  return (
    <DocsPage
      full={page.data.full}
      tableOfContent={{
        style: 'clerk',
        footer: (
          <div className="my-3 space-y-3">
            <Separator />
            <EditSource path={page.path} />
            <ScrollTop />
            <Feedback />
            <CopyPage text={markdown} />
            <AskAI href={publicUrl} />
            <OpenInChat href={publicUrl} />
          </div>
        ),
      }}
      tableOfContentPopover={{ enabled: false }}
      toc={page.data.toc}
    >
      <MobileDocsBar toc={page.data.toc} />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: PublicCookbookLink,
            Badge,
            Step,
            Steps,
            Tabs,
            Tab,
          })}
        />
      </DocsBody>
    </DocsPage>
  );
};

export const generateStaticParams = () => {
  // Generate params for all cookbook pages
  const allParams = source.generateParams();
  return allParams
    .filter((p) => Array.isArray(p.slug) && p.slug[0] === 'cookbook')
    .map((p) => ({
      ...p,
      slug: (p.slug as string[]).slice(1), // Remove 'cookbook' prefix
    }));
};

export const generateMetadata = async ({
  params,
}: PageProps<'/[lang]/cookbook/[[...slug]]'>) => {
  const { slug, lang } = await params;
  const resolvedSlug = slug ? ['cookbook', ...slug] : ['cookbook'];
  const page = source.getPage(resolvedSlug, lang);

  if (!page) {
    notFound();
  }

  const publicPath = rewriteCookbookUrl(page.url);

  const metadata: Metadata = {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page).url,
    },
    alternates: {
      canonical: publicPath,
      types: {
        'text/markdown': `${publicPath}.md`,
      },
    },
  };

  return metadata;
};

export default Page;
