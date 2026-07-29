import type { TableOfContents } from 'fumadocs-core/toc';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { FluidComputeCallout } from '@/components/custom/fluid-compute-callout';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { v5WorldsSource, worldsSource } from '@/lib/geistdocs/source';
import { rewriteHrefForVersion } from '@/lib/geistdocs/version-href';
import type { DocsVersionId } from '@/lib/geistdocs/versions';
import { getWorldData } from '@/lib/worlds-data';
import { WorldDataProvider } from './WorldDataProvider';
import { WorldDetailHero } from './WorldDetailHero';
import { WorldDetailToc } from './WorldDetailToc';
import { WorldInstructions } from './WorldInstructions';
import { WorldTestingPerformance } from './WorldTestingPerformance';
import { WorldTestingPerformanceMDX } from './WorldTestingPerformanceMDX';
import { WorldVersionSelect } from './WorldVersionSelect';

const isPreview = process.env.VERCEL_ENV === 'preview';

/** MDX wrapper — passes preview gate to benchmark section */
const WorldTestingPerformanceForMDX = (props: Record<string, unknown>) => (
  <WorldTestingPerformanceMDX {...props} showBenchmarks={isPreview} />
);

// Official worlds with a page in the content/worlds/<version> collections
const officialWorldMdxSlugs: Record<string, string[]> = {
  local: ['local'],
  postgres: ['postgres'],
  vercel: ['vercel'],
};

const VERSION_SOURCES = {
  v4: worldsSource,
  v5: v5WorldsSource,
} as const;

const VERSION_PREFIXES = {
  v4: '',
  v5: '/v5',
} as const;

export const officialWorldIds = Object.keys(officialWorldMdxSlugs);

export async function generateWorldMetadata(
  id: string,
  version: DocsVersionId
): Promise<Metadata> {
  const data = await getWorldData(id);

  if (!data) {
    return {
      title: 'World Not Found',
    };
  }

  const versionPrefix = VERSION_PREFIXES[version];
  const isPreRelease = version === 'v5';

  return {
    title: `${data.world.name} World${isPreRelease ? ' · Pre-release' : ''} | Workflow SDK`,
    description: data.world.description,
    openGraph: {
      images: [`/og/worlds/${id}`],
    },
    alternates: {
      canonical: `/worlds/${id}`,
      types: {
        'text/markdown': `${versionPrefix}/worlds/${id}.md`,
      },
    },
    ...(isPreRelease
      ? {
          robots: {
            index: false,
            follow: true,
          },
        }
      : {}),
  };
}

export async function WorldDetailPage({
  id,
  version,
}: {
  id: string;
  version: DocsVersionId;
}) {
  const data = await getWorldData(id);

  if (!data) {
    notFound();
  }

  const { world, meta } = data;

  // For official worlds, load MDX content and extract TOC
  const isOfficial = world.type === 'official' && officialWorldMdxSlugs[id];

  // Community worlds have no versioned content — their canonical page lives
  // at /worlds/<id> only.
  if (version !== 'v4' && !isOfficial) {
    redirect(`/worlds/${id}`);
  }

  const source = VERSION_SOURCES[version];
  const versionPrefix = VERSION_PREFIXES[version];

  let mdxContent: ReactNode = null;
  let tocItems: { id: string; title: ReactNode }[] = [];

  if (isOfficial) {
    const slugs = officialWorldMdxSlugs[id];
    const page = source.getPage(slugs);

    if (page) {
      const pageData = page.data as typeof page.data & {
        body: ComponentType<{ components?: Record<string, unknown> }>;
        toc: TableOfContents;
      };
      const MDX = pageData.body;

      // Extract TOC from MDX headings (only h2s, not h3s)
      tocItems = pageData.toc
        .filter((item) => item.depth === 2)
        .map((item) => ({
          id: item.url.slice(1), // Remove leading #
          title: item.title,
        }));

      // Content links are authored against the raw /docs/... and /worlds/...
      // URL spaces; on the pre-release route they are rewritten into the /v5
      // view so navigation doesn't escape to the current-version pages.
      const RelativeLink = createRelativeLink(source, page);
      const VersionedLink = (props: ComponentProps<'a'>) => (
        <RelativeLink
          {...props}
          href={rewriteHrefForVersion(props.href, versionPrefix)}
        />
      );

      mdxContent = (
        <MDX
          components={getMDXComponents({
            a: VersionedLink,
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
            <WorldDetailHero
              id={id}
              world={world}
              versionSelect={
                isOfficial ? <WorldVersionSelect current={version} /> : null
              }
            />
          </div>

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
