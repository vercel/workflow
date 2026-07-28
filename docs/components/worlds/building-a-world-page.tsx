import type { TableOfContents } from 'fumadocs-core/toc';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { v5WorldsSource, worldsSource } from '@/lib/geistdocs/source';
import { rewriteHrefForVersion } from '@/lib/geistdocs/version-href';
import type { DocsVersionId } from '@/lib/geistdocs/versions';
import { WorldDetailToc } from './WorldDetailToc';
import { WorldVersionSelect } from './WorldVersionSelect';

const PAGE_SLUGS = ['building-a-world'];

const VERSION_SOURCES = {
  v4: worldsSource,
  v5: v5WorldsSource,
} as const;

const VERSION_PREFIXES = {
  v4: '',
  v5: '/v5',
} as const;

export async function generateBuildingAWorldMetadata(
  version: DocsVersionId
): Promise<Metadata> {
  const page = VERSION_SOURCES[version].getPage(PAGE_SLUGS);

  if (!page) {
    return { title: 'Building a World | Workflow SDK' };
  }

  const versionPrefix = VERSION_PREFIXES[version];
  const isPreRelease = version === 'v5';

  return {
    title: `${page.data.title}${isPreRelease ? ' · Pre-release' : ''} | Workflow SDK`,
    description: page.data.description,
    openGraph: {
      images: ['/og/worlds'],
    },
    alternates: {
      canonical: '/worlds/building-a-world',
      types: {
        'text/markdown': `${versionPrefix}/worlds/building-a-world.md`,
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

export async function BuildingAWorldPage({
  version,
}: {
  version: DocsVersionId;
}) {
  const source = VERSION_SOURCES[version];
  const versionPrefix = VERSION_PREFIXES[version];
  const page = source.getPage(PAGE_SLUGS);

  if (!page) {
    notFound();
  }

  const pageData = page.data as typeof page.data & {
    body: ComponentType<{ components?: Record<string, unknown> }>;
    toc: TableOfContents;
  };
  const MDX = pageData.body;

  const tocItems: { id: string; title: ReactNode }[] = pageData.toc
    .filter((item) => item.depth === 2)
    .map((item) => ({
      id: item.url.slice(1), // Remove leading #
      title: item.title,
    }));

  // Content links are authored against the raw /docs/... and /worlds/... URL
  // spaces; on the pre-release route they are rewritten into the /v5 view.
  const RelativeLink = createRelativeLink(source, page);
  const VersionedLink = (props: ComponentProps<'a'>) => (
    <RelativeLink
      {...props}
      href={rewriteHrefForVersion(props.href, versionPrefix)}
    />
  );

  return (
    <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter">
      <div className="mx-auto w-full max-w-[1080px] px-4">
        {/* Header */}
        <div className="mt-[var(--fd-nav-height)] pt-10 sm:pt-16">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="font-semibold text-4xl leading-[1.1] tracking-tight sm:text-5xl">
                {page.data.title}
              </h1>
              <p className="mt-4 max-w-2xl text-muted-foreground sm:text-lg">
                {page.data.description}
              </p>
            </div>
            <div className="w-full sm:w-56 shrink-0">
              <WorldVersionSelect current={version} />
            </div>
          </div>
        </div>

        {/* Content + TOC Grid */}
        <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-8 lg:gap-12">
          <main className="min-w-0">
            <div className="py-8 sm:py-12 prose prose-neutral dark:prose-invert max-w-none">
              <MDX
                components={getMDXComponents({
                  a: VersionedLink,
                })}
              />
            </div>
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
  );
}
