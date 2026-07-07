import { Card, type CardProps } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ComponentProps, ReactNode } from 'react';
import { PlainGlobe } from '@/app/[lang]/(home)/components/vercel-com-visuals/plain-globe';
import { FluidComputeCallout } from '@/components/custom/fluid-compute-callout';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  BenchmarkBar,
  BenchmarkChart,
} from '@/components/worlds/BenchmarkChart';
import { WorldDataProvider } from '@/components/worlds/WorldDataProvider';
import { WorldDetailHero } from '@/components/worlds/WorldDetailHero';
import { WorldDetailToc } from '@/components/worlds/WorldDetailToc';
import { WorldInstructions } from '@/components/worlds/WorldInstructions';
import { WorldsFilteredGrid } from '@/components/worlds/WorldsFilteredGrid';
import { WorldTestingPerformance } from '@/components/worlds/WorldTestingPerformance';
import { WorldTestingPerformanceMDX } from '@/components/worlds/WorldTestingPerformanceMDX';
import { source, v5Source } from '@/lib/geistdocs/source';
import {
  buildVersionUrl,
  LATEST_VERSION,
  PRE_RELEASE_VERSION,
} from '@/lib/geistdocs/versions';
import { getWorldData, getWorldIds, getWorldsData } from '@/lib/worlds-data';

export type WorldDocsVersion = 'v4' | 'v5';

const isPreview = process.env.VERCEL_ENV === 'preview';

const officialWorldMdxSlugs: Record<string, string[]> = {
  local: ['deploying', 'world', 'local-world'],
  postgres: ['deploying', 'world', 'postgres-world'],
  vercel: ['deploying', 'world', 'vercel-world'],
};

const getWorldVersionConfig = (version: WorldDocsVersion) => {
  const docsVersion = version === 'v5' ? PRE_RELEASE_VERSION : LATEST_VERSION;
  return {
    docsPrefix: docsVersion.prefix,
    docsVersion,
    source: version === 'v5' ? v5Source : source,
    worldsPath: `/${version}/worlds`,
  };
};

const WorldTestingPerformanceForMDX = (props: Record<string, unknown>) => (
  <WorldTestingPerformanceMDX {...props} showBenchmarks={isPreview} />
);

function rewriteHref<T>(href: T, version: WorldDocsVersion): T {
  if (typeof href !== 'string') return href;
  const { docsVersion } = getWorldVersionConfig(version);
  return buildVersionUrl(href, docsVersion) as T;
}

export const worldsMetadata: Metadata = {
  title: 'Worlds | Workflow SDK',
  description:
    'The World abstraction allows workflows to run anywhere - locally, on Vercel, or on any cloud. The runtime, queues, and persistence are modular and entirely swappable.',
  openGraph: {
    images: ['/og/worlds'],
  },
};

export const compareWorldsMetadata: Metadata = {
  title: 'Compare World Benchmarks - Workflow',
  description:
    'Compare performance benchmarks across all Workflow World implementations.',
  robots: {
    index: false,
    follow: false,
  },
};

export async function VersionedWorldsPage({
  version,
}: {
  version: WorldDocsVersion;
}) {
  const data = await getWorldsData();
  const { docsPrefix, worldsPath } = getWorldVersionConfig(version);

  const sortedWorlds = Object.entries(data.worlds).sort(([, a], [, b]) => {
    if (a.type === 'official' && b.type !== 'official') return -1;
    if (a.type !== 'official' && b.type === 'official') return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter sm:mt-24">
      <div className="mx-auto w-full max-w-[1080px]">
        <section className="relative px-4 overflow-hidden text-center h-[340px]">
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-[85%] translate-y-[20%]">
              <PlainGlobe />
            </div>
          </div>

          <div className="relative z-10 mt-32 sm:mt-28 mx-auto w-full max-w-3xl space-y-3 sm:space-y-5">
            <h1 className="text-center font-semibold text-4xl leading-[1.1] tracking-tight sm:text-5xl xl:text-6xl text-balance">
              Worlds
            </h1>
            <p className="text-balance text-muted-foreground sm:text-xl leading-relaxed">
              The World abstraction allows workflows to run anywhere - locally,
              on Vercel, or on any cloud. The runtime, queues, and persistence
              are modular and entirely swappable.
            </p>
          </div>
        </section>

        <WorldsFilteredGrid worlds={sortedWorlds} worldsPath={worldsPath} />

        <div className="px-4 pb-8 text-center text-xs text-muted-foreground">
          Last updated: {new Date(data.lastUpdated).toLocaleString()}
          {data.commit && (
            <>
              {' - '}
              Commit:{' '}
              <a
                href={`https://github.com/vercel/workflow/commit/${data.commit}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono hover:underline"
              >
                {data.commit.slice(0, 7)}
              </a>
            </>
          )}
        </div>

        <section className="border-t px-4 py-12 sm:py-16">
          <div className="flex flex-col lg:flex-row gap-8 items-start justify-between">
            <div className="space-y-4 mt-4 max-w-md">
              <div className="flex items-center gap-2.5">
                <h2 className="font-semibold text-2xl tracking-tight sm:text-3xl">
                  Provider Benchmarks
                </h2>
                <Badge variant="outline" className="text-sm">
                  Coming soon
                </Badge>
              </div>
              <p className="text-muted-foreground max-w-md">
                See how workflows compare across the different worlds deployed
                on different providers. Lower execution time means faster
                workflows.
              </p>
            </div>

            <div className="w-full lg:max-w-lg min-w-0 space-y-3">
              {[
                {
                  name: 'Local',
                  time: 10.76,
                  color: 'bg-green-700 dark:bg-green-600',
                },
                { name: 'Vercel', time: 19.37, color: 'bg-blue-700' },
                { name: 'AWS', time: 25.82, color: 'bg-blue-700' },
                { name: 'GCP', time: 25.82, color: 'bg-blue-700' },
              ].map((provider) => {
                const maxTime = 25.82;
                const width = (provider.time / maxTime) * 100;

                return (
                  <div
                    key={provider.name}
                    className="flex items-center gap-4 w-full"
                  >
                    <div className="w-14 text-sm truncate text-right text-muted-foreground">
                      {provider.name}
                    </div>
                    <div className="w-full h-8 bg-gray-100 rounded-md overflow-hidden">
                      <div
                        className={`h-full rounded-md transition-all ${provider.color}`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <div className="w-13 shrink-0 text-right font-mono text-gray-900 text-sm">
                      {provider.time.toFixed(2)}s
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-gray-900 text-right pt-1">
                For illustration purposes only
              </p>
            </div>
          </div>
        </section>

        <section className="border-t px-4 py-8 sm:pt-24 sm:pb-16 sm:px-12">
          <div className="max-w-2xl mx-auto text-center space-y-4">
            <h2 className="font-semibold text-3xl tracking-tight sm:text-4xl">
              Learn more about worlds
            </h2>
            <p className="text-muted-foreground">
              To learn more about how worlds work or to create your own, check
              the docs. You can also build a custom world to connect workflows
              to any storage or queuing backend.
            </p>
            <div className="flex justify-center gap-3 mt-8">
              <Button asChild size="lg">
                <Link href={`${docsPrefix}/docs/deploying/building-a-world`}>
                  World Interface Docs
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <a
                  href="https://github.com/vercel/workflow/blob/main/worlds-manifest.json"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Submit Your World
                </a>
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export const generateWorldStaticParams = () =>
  getWorldIds().map((id) => ({ id }));

export async function generateWorldMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
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

export async function VersionedWorldDetailPage({
  params,
  version,
}: {
  params: Promise<{ id: string }>;
  version: WorldDocsVersion;
}) {
  const { id } = await params;
  const data = await getWorldData(id);

  if (!data) {
    notFound();
  }

  const {
    docsPrefix,
    source: docsSource,
    worldsPath,
  } = getWorldVersionConfig(version);
  const { world, meta } = data;
  const isOfficial = world.type === 'official' && officialWorldMdxSlugs[id];
  let mdxContent: React.ReactNode = null;
  let tocItems: { id: string; title: ReactNode }[] = [];

  if (isOfficial) {
    const page = docsSource.getPage(officialWorldMdxSlugs[id]);

    if (page) {
      const MDX = page.data.body;
      const baseLink = createRelativeLink(docsSource, page);
      function versionedLink(props: ComponentProps<typeof baseLink>) {
        return baseLink({
          ...props,
          href: rewriteHref(props.href, version),
        });
      }
      function VersionedCard(props: CardProps) {
        return <Card {...props} href={rewriteHref(props.href, version)} />;
      }

      tocItems = page.data.toc
        .filter((item) => item.depth === 2)
        .map((item) => ({
          id: item.url.slice(1),
          title: item.title,
        }));

      mdxContent = (
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
      );
    }
  } else {
    tocItems = [
      { id: 'installation', title: 'Installation & Usage' },
      { id: 'testing', title: 'Testing & Compatibility' },
    ];
  }

  return (
    <WorldDataProvider worldId={id} world={world} meta={meta}>
      <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter">
        <div className="mx-auto w-full max-w-[1080px] px-4">
          <div className="mt-[var(--fd-nav-height)]">
            <WorldDetailHero
              id={id}
              world={world}
              docsPrefix={docsPrefix}
              worldsPath={worldsPath}
            />
          </div>

          <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-8 lg:gap-12">
            <main className="min-w-0">
              {isOfficial && mdxContent ? (
                <div className="py-8 sm:py-12 prose prose-neutral dark:prose-invert max-w-none">
                  {mdxContent}
                </div>
              ) : (
                <>
                  <WorldInstructions id={id} world={world} />
                  <WorldTestingPerformance
                    worldId={id}
                    world={world}
                    meta={meta}
                    showBenchmarks={isPreview}
                  />
                </>
              )}
            </main>

            <aside className="hidden lg:block pt-8 sm:pt-12">
              <div className="sticky top-24">
                <WorldDetailToc items={tocItems} />
              </div>
            </aside>
          </div>
        </div>
      </div>
    </WorldDataProvider>
  );
}

export async function VersionedCompareBenchmarksPage({
  version,
}: {
  version: WorldDocsVersion;
}) {
  const data = await getWorldsData();
  const { worldsPath } = getWorldVersionConfig(version);
  const benchmarkNames = new Set<string>();

  for (const world of Object.values(data.worlds)) {
    if (world.benchmark?.metrics) {
      for (const name of Object.keys(world.benchmark.metrics)) {
        benchmarkNames.add(name);
      }
    }
  }
  const sortedBenchmarks = Array.from(benchmarkNames).sort();

  return (
    <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter">
      <div className="mx-auto w-full max-w-[1080px]">
        <section className="mt-[var(--fd-nav-height)] space-y-6 px-4 pt-16 sm:pt-24 pb-12 text-center border-b">
          <div className="mx-auto w-full max-w-3xl space-y-4">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              Benchmark Comparison
            </h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto text-balance">
              Compare workflow execution performance across all World
              implementations. Lower times are better.
            </p>
          </div>
          <Button
            asChild
            variant="outline"
            size="lg"
            className="h-[44px] text-base"
          >
            <Link href={worldsPath}>Back to Worlds</Link>
          </Button>
        </section>

        <section className="px-4 py-8 sm:py-12 sm:px-12 border-b">
          <div className="space-y-6">
            <h2 className="font-semibold text-xl tracking-tight sm:text-2xl">
              Performance Overview
            </h2>
            <p className="text-muted-foreground">
              Average workflow execution time across different benchmark
              scenarios. Times shown are mean values in milliseconds.
            </p>
            <BenchmarkChart data={data} />
          </div>
        </section>

        <section className="px-4 py-8 sm:py-12 sm:px-12">
          <div className="space-y-8">
            <h2 className="font-semibold text-xl tracking-tight sm:text-2xl">
              Individual Benchmarks
            </h2>
            {sortedBenchmarks.map((benchName) => (
              <div
                key={benchName}
                className="space-y-4 pb-6 border-b last:border-b-0"
              >
                <h3 className="font-medium text-lg">{benchName}</h3>
                <BenchmarkBar data={data} benchmarkName={benchName} />
              </div>
            ))}
            {sortedBenchmarks.length === 0 && (
              <p className="text-muted-foreground">
                No benchmark data is currently available.
              </p>
            )}
          </div>
        </section>

        <div className="border-t px-4 py-6 text-center text-xs text-muted-foreground">
          Last updated: {new Date(data.lastUpdated).toLocaleString()}
          {data.commit && (
            <>
              {' - '}
              Commit:{' '}
              <a
                href={`https://github.com/vercel/workflow/commit/${data.commit}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono hover:underline"
              >
                {data.commit.slice(0, 7)}
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
