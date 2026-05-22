import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ComponentProps } from 'react';
import {
  rewriteCookbookUrlForVersion,
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
import { getLLMText, getPageImage, v5Source } from '@/lib/geistdocs/source';
import { PRE_RELEASE_VERSION } from '@/lib/geistdocs/versions';

const VERSION_PREFIX = PRE_RELEASE_VERSION.prefix; // '/v5'

const Page = async ({
  params,
}: PageProps<'/[lang]/v5/cookbook/[[...slug]]'>) => {
  const { slug, lang } = await params;

  const resolvedSlug = slug ? ['cookbook', ...slug] : ['cookbook'];
  const page = v5Source.getPage(resolvedSlug, lang);

  if (!page) {
    notFound();
  }

  const publicUrl = rewriteCookbookUrlForVersion(page.url, VERSION_PREFIX);
  const publicPage = { ...page, url: publicUrl } as typeof page;

  const markdown = rewriteCookbookUrlsInText(await getLLMText(page));
  const MDX = page.data.body;

  // Rewrite /docs/cookbook/... links to /v5/cookbook/... and other /docs/...
  // links to /v5/docs/... so inline MDX links stay within the v5 context.
  const RelativeLink = createRelativeLink(v5Source, publicPage);
  const V5CookbookLink = (props: ComponentProps<typeof RelativeLink>) => {
    let href = props.href;
    if (typeof href === 'string') {
      href = rewriteCookbookUrlForVersion(href, VERSION_PREFIX);
      if (href.startsWith('/docs/')) href = `${VERSION_PREFIX}${href}`;
    }
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
            a: V5CookbookLink,
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
  const allParams = v5Source.generateParams();
  return allParams
    .filter((p) => Array.isArray(p.slug) && p.slug[0] === 'cookbook')
    .map((p) => ({
      ...p,
      slug: (p.slug as string[]).slice(1),
    }));
};

export const generateMetadata = async ({
  params,
}: PageProps<'/[lang]/v5/cookbook/[[...slug]]'>): Promise<Metadata> => {
  const { slug, lang } = await params;
  const resolvedSlug = slug ? ['cookbook', ...slug] : ['cookbook'];
  const page = v5Source.getPage(resolvedSlug, lang);

  if (!page) {
    notFound();
  }

  const publicPath = rewriteCookbookUrlForVersion(page.url, VERSION_PREFIX);

  return {
    title: `${page.data.title} · Pre-release`,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page).url,
    },
    alternates: {
      // Canonical points to the v4 cookbook (same content, stable URL).
      canonical: rewriteCookbookUrlForVersion(page.url, ''),
      types: {
        'text/markdown': `${publicPath}.md`,
      },
    },
    robots: {
      index: false,
      follow: true,
    },
  };
};

export default Page;
