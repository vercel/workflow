import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { AgentTraces } from '@/components/custom/agent-traces';
import { FluidComputeCallout } from '@/components/custom/fluid-compute-callout';
import { AskAI } from '@/components/geistdocs/ask-ai';
import { AutoCards } from '@/components/geistdocs/auto-cards';
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
import { resolveSectionChildren } from '@/lib/geistdocs/section-children';
import { getLLMText, getPageImage, source } from '@/lib/geistdocs/source';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { LATEST_VERSION } from '@/lib/geistdocs/versions';
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

  // v4's sidebar tree is already in the `/docs/...` URL space (no version
  // rewrite), so the same tree drives both the rendered cards and the markdown
  // export expansion in getLLMText.
  const tree = getDocsTreeForVersion(lang, LATEST_VERSION);
  const markdown = await getLLMText(page, tree);
  const MDX = page.data.body;

  return (
    <DocsPage
      full={page.data.full}
      tableOfContent={{
        style: 'clerk',
        footer: (
          <div className="my-3 space-y-3">
            <Separator />
            <EditSource path={page.path} version="v4" />
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
            AutoCards: () => (
              <AutoCards items={resolveSectionChildren(tree, page.url)} />
            ),
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
      (params) => !(Array.isArray(params.slug) && params.slug[0] === 'cookbook')
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
