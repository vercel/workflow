import { Card, type CardProps } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ComponentProps, ReactNode } from 'react';
import { FluidComputeCallout } from '@/components/custom/fluid-compute-callout';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { WorldDataProvider } from '@/components/worlds/WorldDataProvider';
import { WorldDetailHero } from '@/components/worlds/WorldDetailHero';
import { WorldDetailToc } from '@/components/worlds/WorldDetailToc';
import { WorldInstructions } from '@/components/worlds/WorldInstructions';
import { WorldTestingPerformance } from '@/components/worlds/WorldTestingPerformance';
import { WorldTestingPerformanceMDX } from '@/components/worlds/WorldTestingPerformanceMDX';
import { source, v5Source } from '@/lib/geistdocs/source';
import { cn } from '@/lib/utils';
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
  searchParams?: Promise<{ version?: string | string[] }>;
}

type WorldDocsVersion = 'v4' | 'v5';

function getWorldDocsVersion(version: string | string[] | undefined) {
  return version === 'v4' ? 'v4' : 'v5';
}

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

function WorldDocsVersionToggle({
  activeVersion,
  id,
}: {
  activeVersion: WorldDocsVersion;
  id: string;
}) {
  return (
    <div className="mt-6 flex justify-end">
      <fieldset className="inline-flex rounded-md border bg-background-100 p-0.5">
        <legend className="sr-only">World docs version</legend>
        {(['v4', 'v5'] as const).map((version) => (
          <Link
            key={version}
            href={`/worlds/${id}?version=${version}`}
            className={cn(
              'rounded-sm px-3 py-1.5 font-medium text-sm transition-colors',
              version === activeVersion
                ? 'bg-background-200 text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {version}
          </Link>
        ))}
      </fieldset>
    </div>
  );
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

export default async function WorldDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const { version } = (await searchParams) ?? {};
  const docsVersion = getWorldDocsVersion(version);
  const data = await getWorldData(id);

  if (!data) {
    notFound();
  }

  const { world, meta } = data;

  // For official worlds, load MDX content and extract TOC
  const isOfficial = world.type === 'official' && officialWorldMdxSlugs[id];
  let mdxContent: React.ReactNode = null;
  let tocItems: { id: string; title: ReactNode }[] = [];

  if (isOfficial) {
    const slugs = officialWorldMdxSlugs[id];
    const docsSource = docsVersion === 'v4' ? source : v5Source;
    const page = docsSource.getPage(slugs);

    if (page) {
      const MDX = page.data.body;
      const baseLink = createRelativeLink(docsSource, page);
      function versionedLink(props: ComponentProps<typeof baseLink>) {
        return baseLink({
          ...props,
          href: versionedHref(props.href, docsVersion),
        });
      }
      function VersionedCard(props: CardProps) {
        return (
          <Card {...props} href={versionedHref(props.href, docsVersion)} />
        );
      }

      // Extract TOC from MDX headings (only h2s, not h3s)
      tocItems = page.data.toc
        .filter((item) => item.depth === 2)
        .map((item) => ({
          id: item.url.slice(1), // Remove leading #
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
          {isOfficial && (
            <WorldDocsVersionToggle activeVersion={docsVersion} id={id} />
          )}

          {/* Content + TOC Grid */}
          <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-8 lg:gap-12">
            {/* Main Content */}
            <main className="min-w-0">
              {isOfficial && mdxContent ? (
                // Official worlds: MDX controls the entire content structure
                <div className="py-8 sm:py-12 prose prose-neutral dark:prose-invert max-w-none">
                  {mdxContent}
                </div>
              ) : (
                // Community worlds: use template components
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

            {/* TOC Sidebar - sticky on desktop, hidden on mobile */}
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
