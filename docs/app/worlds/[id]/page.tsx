import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { WorldDetailHero } from '@/components/worlds/WorldDetailHero';
import { WorldDetailToc } from '@/components/worlds/WorldDetailToc';
import { WorldInstructions } from '@/components/worlds/WorldInstructions';
import { WorldTestingPerformance } from '@/components/worlds/WorldTestingPerformance';
import { WorldDataProvider } from '@/components/worlds/WorldDataProvider';
import { WorldTestingPerformanceMDX } from '@/components/worlds/WorldTestingPerformanceMDX';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { getWorldData, getWorldIds } from '@/lib/worlds-data';
import { source } from '@/lib/geistdocs/source';

// Map world IDs to their MDX doc slugs
const officialWorldMdxSlugs: Record<string, string[]> = {
  local: ['deploying', 'world', 'local-world'],
  postgres: ['deploying', 'world', 'postgres-world'],
  vercel: ['deploying', 'world', 'vercel-world'],
};

interface PageProps {
  params: Promise<{ id: string }>;
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
    title: `${data.world.name} World | Workflow DevKit`,
    description: data.world.description,
    openGraph: {
      title: `${data.world.name} World | Workflow DevKit`,
      description: data.world.description,
      images: [`/worlds/${id}/og`],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${data.world.name} World | Workflow DevKit`,
      description: data.world.description,
      images: [`/worlds/${id}/og`],
    },
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
  let mdxContent: React.ReactNode = null;
  let tocItems: { id: string; title: ReactNode }[] = [];

  if (isOfficial) {
    const slugs = officialWorldMdxSlugs[id];
    const page = source.getPage(slugs);

    if (page) {
      const MDX = page.data.body;

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
            a: createRelativeLink(source, page),
            Step,
            Steps,
            Tabs,
            Tab,
            // MDX-usable component for Testing & Performance section
            WorldTestingPerformance: WorldTestingPerformanceMDX,
          })}
        />
      );
    }
  } else {
    // Community worlds use hardcoded TOC
    tocItems = [
      { id: 'installation', title: 'Installation & Usage' },
      { id: 'testing', title: 'Testing & Performance' },
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

          {/* Content + TOC Grid */}
          <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-8 lg:gap-12">
            {/* Main Content */}
            <main className="min-w-0">
              {isOfficial && mdxContent ? (
                // Official worlds: MDX controls the entire content structure
                <div className="py-8 sm:py-12 border-t prose prose-neutral dark:prose-invert max-w-none">
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
