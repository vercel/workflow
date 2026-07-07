import { Card, type CardProps } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ComponentProps, ReactNode } from 'react';
import { FluidComputeCallout } from '@/components/custom/fluid-compute-callout';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { WorldDataProvider } from '@/components/worlds/WorldDataProvider';
import { WorldDetailHero } from '@/components/worlds/WorldDetailHero';
import { WorldDetailToc } from '@/components/worlds/WorldDetailToc';
import { WorldDocsVersionPanel } from '@/components/worlds/WorldDocsVersionPanel';
import { WorldInstructions } from '@/components/worlds/WorldInstructions';
import { WorldTestingPerformance } from '@/components/worlds/WorldTestingPerformance';
import { WorldTestingPerformanceMDX } from '@/components/worlds/WorldTestingPerformanceMDX';
import { source, v5Source } from '@/lib/geistdocs/source';
import { getWorldData, getWorldIds } from '@/lib/worlds-data';

const isPreview = process.env.VERCEL_ENV === 'preview';

/** MDX wrapper — passes preview gate to benchmark section */
const WorldTestingPerformanceForMDX = (props: Record<string, unknown>) => (
  <WorldTestingPerformanceMDX {...props} showBenchmarks={isPreview} />
);

// Map world IDs to their MDX doc slugs
const officialWorldMdxSlugs: Record<string, string[]> = {
  local: ['deploying', 'world', 'local-world'],
  postgres: ['deploying', 'world', 'postgres-world'],
  vercel: ['deploying', 'world', 'vercel-world'],
};

interface PageProps {
  params: Promise<{ id: string }>;
}

type WorldDocsVersion = 'v4' | 'v5';

function versionedHref<T>(href: T, version: WorldDocsVersion): T {
  if (typeof href !== 'string') return href;
  if (version === 'v5' && href.startsWith('/docs/')) {
    return `/v5${href}` as T;
  }
  if (href.startsWith('/worlds/')) {
    return `${href}?version=${version}` as T;
  }
  return href;
}

export async function generateStaticParams() {
  const ids = getWorldIds();
  return ids.map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const data = await getWorldData(id);

  if (!data) {
    return {
      title: 'World Not Found',
    };
  }

  return {
    title: `${data.world.name} World | Workflow SDK`,
    description: data.world.description,
    openGraph: {
      images: [`/og/worlds/${id}`],
    },
  };
}

function renderOfficialWorldDocs(id: string, version: WorldDocsVersion) {
  const slugs = officialWorldMdxSlugs[id];
  const docsSource = version === 'v4' ? source : v5Source;
  const page = docsSource.getPage(slugs);

  if (!page) {
    return null;
  }

  const MDX = page.data.body;
  const baseLink = createRelativeLink(docsSource, page);
  function versionedLink(props: ComponentProps<typeof baseLink>) {
    return baseLink({
      ...props,
      href: versionedHref(props.href, version),
    });
  }
  function VersionedCard(props: CardProps) {
    return <Card {...props} href={versionedHref(props.href, version)} />;
  }

  return {
    content: (
      <MDX
        components={getMDXComponents({
          a: versionedLink,
          Card: VersionedCard,
          Step,
          Steps,
          Tabs,
          Tab,
          FluidComputeCallout,
          WorldTestingPerformance: WorldTestingPerformanceForMDX,
        })}
      />
    ),
    tocItems: page.data.toc
      .filter((item) => item.depth === 2)
      .map((item) => ({
        id: item.url.slice(1),
        title: item.title,
      })),
  };
}

export default async function WorldDetailPage({ params }: PageProps) {
  const { id } = await params;
  const data = await getWorldData(id);

  if (!data) {
    notFound();
  }

  const { world, meta } = data;

  // For official worlds, load MDX content and extract TOC
  const isOfficial = world.type === 'official' && officialWorldMdxSlugs[id];
  const v4Docs = isOfficial ? renderOfficialWorldDocs(id, 'v4') : null;
  const v5Docs = isOfficial ? renderOfficialWorldDocs(id, 'v5') : null;
  let tocItems: { id: string; title: ReactNode }[] = [];

  if (!isOfficial) {
    // Community worlds use hardcoded TOC
    tocItems = [
      { id: 'installation', title: 'Installation & Usage' },
      { id: 'testing', title: 'Testing & Compatibility' },
    ];
  }

  return (
    <WorldDataProvider worldId={id} world={world} meta={meta}>
      <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter">
        <div className="mx-auto w-full max-w-[1080px] px-4">
          {/* Hero Section */}
          <div className="mt-[var(--fd-nav-height)]">
            <WorldDetailHero id={id} world={world} />
          </div>

          {isOfficial && v4Docs && v5Docs ? (
            <WorldDocsVersionPanel
              id={id}
              v4Content={v4Docs.content}
              v4TocItems={v4Docs.tocItems}
              v5Content={v5Docs.content}
              v5TocItems={v5Docs.tocItems}
            />
          ) : (
            <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-8 lg:gap-12">
              <main className="min-w-0">
                <WorldInstructions id={id} world={world} />
                <WorldTestingPerformance
                  worldId={id}
                  world={world}
                  meta={meta}
                  showBenchmarks={isPreview}
                />
              </main>

              <aside className="hidden lg:block pt-8 sm:pt-12">
                <div className="sticky top-24">
                  <WorldDetailToc items={tocItems} />
                </div>
              </aside>
            </div>
          )}
        </div>
      </div>
    </WorldDataProvider>
  );
}
