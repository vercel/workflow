import type { TableOfContents } from 'fumadocs-core/toc';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ComponentType, ReactNode } from 'react';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { WorldDetailToc } from '@/components/worlds/WorldDetailToc';
import { worldsSource } from '@/lib/geistdocs/source';

const PAGE_SLUGS = ['building-a-world'];

export async function generateMetadata(): Promise<Metadata> {
  const page = worldsSource.getPage(PAGE_SLUGS);

  if (!page) {
    return { title: 'Building a World | Workflow SDK' };
  }

  return {
    title: `${page.data.title} | Workflow SDK`,
    description: page.data.description,
    openGraph: {
      images: ['/og/worlds'],
    },
  };
}

export default async function BuildingAWorldPage() {
  const page = worldsSource.getPage(PAGE_SLUGS);

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

  return (
    <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter">
      <div className="mx-auto w-full max-w-[1080px] px-4">
        {/* Header */}
        <div className="mt-[var(--fd-nav-height)] pt-10 sm:pt-16">
          <h1 className="font-semibold text-4xl leading-[1.1] tracking-tight sm:text-5xl">
            {page.data.title}
          </h1>
          <p className="mt-4 max-w-2xl text-muted-foreground sm:text-lg">
            {page.data.description}
          </p>
        </div>

        {/* Content + TOC Grid */}
        <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-8 lg:gap-12">
          <main className="min-w-0">
            <div className="py-8 sm:py-12 prose prose-neutral dark:prose-invert max-w-none">
              <MDX
                components={getMDXComponents({
                  a: createRelativeLink(worldsSource, page),
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
