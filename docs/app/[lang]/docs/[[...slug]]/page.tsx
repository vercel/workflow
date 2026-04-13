import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { rewriteCookbookUrl } from '@/lib/geistdocs/cookbook-source';
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
import * as AccordionComponents from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { getLLMText, getPageImage, source } from '@/lib/geistdocs/source';
import { TSDoc } from '@/lib/tsdoc';

// No-op component for world MDX files rendered outside /worlds/ context
// These pages redirect to /worlds/[id] but still get statically generated
const WorldTestingPerformanceNoop = () => null;

const Page = async ({ params }: PageProps<'/[lang]/docs/[[...slug]]'>) => {
  const { slug, lang } = await params;

  if (Array.isArray(slug) && slug[0] === 'cookbook') {
    const rest = slug.slice(1).join('/');
    const legacyPath = `/docs/cookbook${rest ? `/${rest}` : ''}`;
    permanentRedirect(`/${lang}${rewriteCookbookUrl(legacyPath)}`);
  }

  const page = source.getPage(slug, lang);

  if (!page) {
    notFound();
  }

  const markdown = await getLLMText(page);
  const MDX = page.data.body;

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
            a: createRelativeLink(source, page),

            // Add your custom components here
            AgentTraces,
            FluidComputeCallout,
            Badge,
            TSDoc,
            Step,
            Steps,
            ...AccordionComponents,
            Tabs,
            Tab,
            // No-op for world MDX files (they redirect to /worlds/[id])
            WorldTestingPerformance: WorldTestingPerformanceNoop,
          })}
        />
      </DocsBody>
    </DocsPage>
  );
};

export const generateStaticParams = () =>
  source
    .generateParams()
    .filter(
      (params) =>
        !(Array.isArray(params.slug) && params.slug[0] === 'cookbook'),
    );

export const generateMetadata = async ({
  params,
}: PageProps<'/[lang]/docs/[[...slug]]'>) => {
  const { slug, lang } = await params;
  const page = source.getPage(slug, lang);

  if (!page) {
    notFound();
  }

  const metadata: Metadata = {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page).url,
    },
    alternates: {
      canonical: page.url,
      types: {
        'text/markdown': `${page.url}.md`,
      },
    },
  };

  return metadata;
};

export default Page;
