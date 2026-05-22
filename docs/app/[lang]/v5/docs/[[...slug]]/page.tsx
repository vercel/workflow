import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { notFound, permanentRedirect } from 'next/navigation';
import { AgentTraces } from '@/components/custom/agent-traces';
import { FluidComputeCallout } from '@/components/custom/fluid-compute-callout';
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
import { MobileDocsBar } from '@/components/geistdocs/mobile-docs-bar';
import { OpenInChat } from '@/components/geistdocs/open-in-chat';
import { ScrollTop } from '@/components/geistdocs/scroll-top';
import { PreviewInstallServer } from '@/components/preview-install-server';
import * as AccordionComponents from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { rewriteCookbookUrl } from '@/lib/geistdocs/cookbook-source';
import {
  getLLMText,
  getPageImage,
  source,
  v5Source,
} from '@/lib/geistdocs/source';
import { TSDoc } from '@/lib/tsdoc';

const WorldTestingPerformanceNoop = () => null;

const Page = async ({ params }: PageProps<'/[lang]/v5/docs/[[...slug]]'>) => {
  const { slug, lang } = await params;

  if (Array.isArray(slug) && slug[0] === 'cookbook') {
    const rest = slug.slice(1).join('/');
    const legacyPath = `/docs/cookbook${rest ? `/${rest}` : ''}`;
    permanentRedirect(`/${lang}${rewriteCookbookUrl(legacyPath)}`);
  }

  const page = v5Source.getPage(slug, lang);
  if (!page) {
    notFound();
  }

  const markdown = await getLLMText(page);
  const MDX = page.data.body;

  // Inline MDX links use /docs/... paths (matching the source baseUrl). When
  // browsing under /v5/docs/..., those links would escape to the v4 route.
  // Rewrite /docs/... → /v5/docs/... so all inline links stay inside the v5
  // context, matching how the sidebar tree is rewritten by rewriteNodeUrls in
  // version-source.ts.
  const baseLink = createRelativeLink(v5Source, page);
  function v5Link(props: ComponentProps<typeof baseLink>) {
    const href =
      typeof props.href === 'string' && props.href.startsWith('/docs/')
        ? `/v5${props.href}`
        : props.href;
    return baseLink({ ...props, href });
  }

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
            <AskAI href={page.url} />
            <OpenInChat href={page.url} />
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
            a: v5Link,
            AgentTraces,
            FluidComputeCallout,
            Badge,
            TSDoc,
            Step,
            Steps,
            ...AccordionComponents,
            Tabs,
            Tab,
            PreviewInstall: PreviewInstallServer,
            WorldTestingPerformance: WorldTestingPerformanceNoop,
          })}
        />
      </DocsBody>
    </DocsPage>
  );
};

export const generateStaticParams = () =>
  v5Source
    .generateParams()
    .filter(
      (params) => !(Array.isArray(params.slug) && params.slug[0] === 'cookbook')
    );

export const generateMetadata = async ({
  params,
}: PageProps<'/[lang]/v5/docs/[[...slug]]'>): Promise<Metadata> => {
  const { slug, lang } = await params;
  const page = v5Source.getPage(slug, lang);
  if (!page) notFound();
  return {
    title: `${page.data.title} · Pre-release`,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page).url,
    },
    // Pre-release pages are not canonical. If the page also exists in v4,
    // point search engines at the v4 URL. Otherwise (v5-only pages) point
    // to the v5 URL as the self-canonical.
    alternates: {
      canonical: source.getPage(slug, lang)
        ? `/${lang}${page.url}`
        : `/${lang}/v5${page.url}`,
    },
    robots: {
      index: false,
      follow: true,
    },
  };
};

export default Page;
