import { AlertTriangle, ExternalLink, Info, Lightbulb } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { codeToHtml } from 'shiki';
import { Mermaid } from '@/components/geistdocs/mermaid';
import { RegistryCodeTabs } from '@/components/patterns/RegistryCodeTabs';
import { RegistryDetailHero } from '@/components/patterns/RegistryDetailHero';
import {
  RegistryDetailToc,
  type RegistryTocItem,
} from '@/components/patterns/RegistryDetailToc';
import { RegistryInstallTabs } from '@/components/patterns/RegistryInstallTabs';
import { getRegistryItem, getRegistryItemIds } from '@/lib/patterns/manifest';
import type { RegistryGuide, RegistrySnippet } from '@/lib/patterns/types';
import { cn } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

export function generateStaticParams() {
  return getRegistryItemIds().map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const item = getRegistryItem(id);
  if (!item) return { title: 'Registry item not found' };
  const ogImage = `/og/patterns/${id}`;
  return {
    title: `${item.name} | Workflow Registry`,
    description: item.description,
    openGraph: {
      images: [ogImage],
    },
    twitter: {
      images: [ogImage],
    },
  };
}

async function renderSnippets(snippets: RegistrySnippet[]) {
  return Promise.all(
    snippets.map(async (snippet) => ({
      label: snippet.label,
      caption: snippet.caption,
      description: snippet.description,
      code: snippet.code,
      html: await codeToHtml(snippet.code, {
        lang: snippet.lang,
        themes: {
          light: 'github-light-default',
          dark: 'github-dark-default',
        },
        defaultColor: false,
      }),
    }))
  );
}

export default async function RegistryDetailPage({ params }: PageProps) {
  const { id } = await params;
  const item = getRegistryItem(id);
  if (!item) notFound();

  const [blocks, conceptBlocks] = await Promise.all([
    renderSnippets(item.snippets),
    item.conceptSnippets
      ? renderSnippets(item.conceptSnippets)
      : Promise.resolve([]),
  ]);

  const guide = item.guide;
  const hasApproachSections = (guide?.approachSections?.length ?? 0) > 0;

  // Index conceptSnippets by label for O(1) lookup in approach sections
  const conceptBlocksByLabel = new Map(conceptBlocks.map((b) => [b.label, b]));

  // Build the ToC items dynamically based on which sections exist
  const tocItems: RegistryTocItem[] = [];

  const useFlatLayout = hasApproachSections || guide?.flatLayout;

  if (guide?.diagram)
    tocItems.push({
      id: 'how-it-fits-together',
      title: guide.diagramTitle ?? 'How it fits together',
      depth: 2,
    });
  if (guide?.whySection)
    tocItems.push({
      id: 'why-use-this',
      title: guide.whySection.title ?? 'Why use this',
      depth: 2,
    });

  if (useFlatLayout) {
    // Flat structure: When to use + Choosing an approach as top-level h2s
    if (guide?.whenToUse)
      tocItems.push({ id: 'when-to-use', title: 'When to use this', depth: 2 });
    if (guide?.approaches)
      tocItems.push({
        id: 'choosing-an-approach',
        title: guide.approaches.title ?? 'Choosing an approach',
        depth: 2,
      });
    if (hasApproachSections) {
      // Per-approach sections (e.g. agent-cancellation)
      for (const section of guide!.approachSections!) {
        tocItems.push({
          id: slugify(section.title),
          title: section.title,
          depth: 2,
        });
      }
    } else {
      // flatLayout without per-approach sections: Installation + Source follow normally
      tocItems.push({ id: 'installation', title: 'Installation', depth: 2 });
      if (conceptBlocks.length > 0)
        tocItems.push({ id: 'concept', title: 'Concept', depth: 2 });
      tocItems.push({ id: 'source', title: 'Source', depth: 2 });
    }
  } else {
    // Umbrella Overview for items without flat layout
    if (guide && (guide.overview || guide.whenToUse || guide.approaches)) {
      tocItems.push({ id: 'overview', title: 'Overview', depth: 2 });
      if (guide.whenToUse)
        tocItems.push({
          id: 'when-to-use',
          title: 'When to use this',
          depth: 3,
        });
      if (guide.approaches)
        tocItems.push({
          id: 'choosing-an-approach',
          title: 'Choosing an approach',
          depth: 3,
        });
    }
    tocItems.push({ id: 'installation', title: 'Installation', depth: 2 });
    if (conceptBlocks.length > 0)
      tocItems.push({ id: 'concept', title: 'Concept', depth: 2 });
    tocItems.push({ id: 'source', title: 'Source', depth: 2 });
  }

  if (guide?.howItWorks)
    tocItems.push({ id: 'how-it-works', title: 'How it works', depth: 2 });
  if (guide?.adapting && guide.adapting.length > 0)
    tocItems.push({
      id: 'adapting-this',
      title: guide.adaptingTitle ?? 'Adapting this',
      depth: 2,
    });
  if (guide?.keyApis && guide.keyApis.length > 0)
    tocItems.push({ id: 'key-apis', title: 'Key APIs', depth: 2 });

  // Plain-text summary for "Copy page"
  const pageTextSections: string[] = [
    `# ${item.name}`,
    item.description,
    `Works with Workflow SDK: ${item.versions.join(', ')}`,
    item.longDescription ?? '',
    ...(guide?.introBullets ?? []).map((b) => `- ${b}`),
  ];

  if (guide?.whenToUse && guide.whenToUse.length > 0) {
    pageTextSections.push('## When to use this');
    guide.whenToUse.forEach((t) => pageTextSections.push(`- ${t}`));
  }

  if (guide?.whySection) {
    pageTextSections.push(`## ${guide.whySection.title ?? 'Why'}`);
    if (guide.whySection.problemProse)
      pageTextSections.push(guide.whySection.problemProse);
    (guide.whySection.problemBullets ?? []).forEach((b) =>
      pageTextSections.push(`- ${b}`)
    );
    if (guide.whySection.solutionProse)
      pageTextSections.push(guide.whySection.solutionProse);
    (guide.whySection.solutionBullets ?? []).forEach((b) =>
      pageTextSections.push(`- ${b}`)
    );
    if (guide.whySection.closingProse)
      pageTextSections.push(guide.whySection.closingProse);
  }

  if (guide?.approaches) {
    pageTextSections.push(
      `## ${guide.approaches.title ?? 'Choosing an approach'}`
    );
    if (guide.approaches.description)
      pageTextSections.push(guide.approaches.description);
    (guide.approaches.bullets ?? []).forEach((b) =>
      pageTextSections.push(`- ${b}`)
    );
    if (guide.approaches.columns && guide.approaches.rows) {
      pageTextSections.push('| ' + guide.approaches.columns.join(' | ') + ' |');
      pageTextSections.push(
        '| ' + guide.approaches.columns.map(() => '---').join(' | ') + ' |'
      );
      guide.approaches.rows.forEach((row) =>
        pageTextSections.push(`| ${row.aspect} | ${row.values.join(' | ')} |`)
      );
    }
    if (guide.approaches.closing)
      pageTextSections.push(guide.approaches.closing);
  }

  if (guide?.sourceDescription) {
    pageTextSections.push('## Source');
    pageTextSections.push(guide.sourceDescription);
  }

  if (guide?.howItWorks && guide.howItWorks.length > 0) {
    pageTextSections.push('## How it works');
    guide.howItWorks.forEach((s, i) => pageTextSections.push(`${i + 1}. ${s}`));
    if (guide.howItWorksClosing) pageTextSections.push(guide.howItWorksClosing);
  }

  if (guide?.adapting && guide.adapting.length > 0) {
    pageTextSections.push(`## ${guide.adaptingTitle ?? 'Adapting this'}`);
    if (guide.adaptingIntro) pageTextSections.push(guide.adaptingIntro);
    guide.adapting.forEach((t) => pageTextSections.push(`- ${t}`));
  }

  if (guide?.keyApis && guide.keyApis.length > 0) {
    pageTextSections.push('## Key APIs');
    guide.keyApis.forEach((api) =>
      pageTextSections.push(`- [${api.label}](${api.url})`)
    );
  }

  if (item.snippets && item.snippets.length > 0) {
    pageTextSections.push('## Source code');
    item.snippets.forEach((s) => {
      pageTextSections.push(
        `### ${s.label}${s.caption ? ` (${s.caption})` : ''}`
      );
      if (s.description) pageTextSections.push(s.description);
      pageTextSections.push('```');
      pageTextSections.push(s.code);
      pageTextSections.push('```');
    });
  }

  const pageText = pageTextSections.filter(Boolean).join('\n\n');

  return (
    <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter">
      <div className="mx-auto w-full max-w-[1080px] px-4">
        <div className="mt-[var(--fd-nav-height)]">
          <RegistryDetailHero item={item} />
        </div>

        <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-8 lg:gap-12">
          {/* ── Main content ── */}
          <main className="min-w-0 py-10 sm:py-12 space-y-14">
            {/* Long-form intro description + optional feature bullets */}
            {(item.longDescription || guide?.introBullets) && (
              <section className="max-w-3xl space-y-3">
                {item.longDescription && (
                  <p className="text-muted-foreground leading-relaxed">
                    <InlineMarkdown text={item.longDescription} />
                  </p>
                )}
                {guide?.introBullets && guide.introBullets.length > 0 && (
                  <ul className="space-y-1.5 ml-0.5">
                    {guide.introBullets.map((tip) => (
                      <li
                        key={tip}
                        className="flex gap-2.5 text-sm text-muted-foreground"
                      >
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/25" />
                        <span>
                          <InlineMarkdown text={tip} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {/* ── Top-level guide callout (e.g. deprecation / migration notice) ── */}
            {guide?.callout && <GuideCallout callout={guide.callout} />}

            {/* ── Diagram (e.g. mermaid flowchart) + optional context bullets ── */}
            {guide?.diagram && (
              <section id="how-it-fits-together" className="space-y-4">
                <h2 className="font-semibold text-2xl tracking-tight">
                  {guide.diagramTitle ?? 'How it fits together'}
                </h2>
                <div className="rounded-lg border bg-muted/30 px-4 overflow-x-auto">
                  <Mermaid chart={guide.diagram} />
                </div>
                {guide.diagramContext && (
                  <div className="space-y-2.5">
                    {guide.diagramContext.prose && (
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        <InlineMarkdown text={guide.diagramContext.prose} />
                      </p>
                    )}
                    {guide.diagramContext.bullets &&
                      guide.diagramContext.bullets.length > 0 && (
                        <ul className="space-y-1.5 ml-0.5">
                          {guide.diagramContext.bullets.map((b) => (
                            <li
                              key={b}
                              className="flex gap-2.5 text-sm text-muted-foreground"
                            >
                              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/25" />
                              <span>
                                <InlineMarkdown text={b} />
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                  </div>
                )}
              </section>
            )}

            {/* ── Why use this (problem/solution framing) ── */}
            {guide?.whySection && (
              <section id="why-use-this" className="space-y-4">
                <h2 className="font-semibold text-2xl tracking-tight">
                  {guide.whySection.title ?? 'Why use this'}
                </h2>
                {guide.whySection.problemProse && (
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {guide.whySection.problemProse}
                  </p>
                )}
                {guide.whySection.problemBullets &&
                  guide.whySection.problemBullets.length > 0 && (
                    <ul className="space-y-1.5 ml-0.5">
                      {guide.whySection.problemBullets.map((b) => (
                        <li
                          key={b}
                          className="flex gap-2.5 text-sm text-muted-foreground"
                        >
                          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/25" />
                          <span>
                            <InlineMarkdown text={b} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                {guide.whySection.solutionProse && (
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {guide.whySection.solutionProse}
                  </p>
                )}
                {guide.whySection.solutionBullets &&
                  guide.whySection.solutionBullets.length > 0 && (
                    <ul className="space-y-1.5 ml-0.5">
                      {guide.whySection.solutionBullets.map((b) => (
                        <li
                          key={b}
                          className="flex gap-2.5 text-sm text-muted-foreground"
                        >
                          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/25" />
                          <span>
                            <InlineMarkdown text={b} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                {guide.whySection.closingProse && (
                  <p className="text-sm text-muted-foreground leading-relaxed italic">
                    <InlineMarkdown text={guide.whySection.closingProse} />
                  </p>
                )}
              </section>
            )}

            {useFlatLayout ? (
              <>
                {/* ── Flat: When to use + Choosing an approach as top-level h2s ── */}
                {guide?.whenToUse && (
                  <section id="when-to-use" className="space-y-3">
                    <h2 className="font-semibold text-2xl tracking-tight">
                      When to use this
                    </h2>
                    <ul className="space-y-1.5 ml-0.5">
                      {guide.whenToUse.map((tip) => (
                        <li
                          key={tip}
                          className="flex gap-2.5 text-sm text-muted-foreground"
                        >
                          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/25" />
                          <span>
                            <InlineMarkdown text={tip} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {guide?.approaches && (
                  <section id="choosing-an-approach" className="space-y-3">
                    <h2 className="font-semibold text-2xl tracking-tight">
                      {guide.approaches.title ?? 'Choosing an approach'}
                    </h2>
                    {guide.approaches.description && (
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {guide.approaches.description}
                      </p>
                    )}
                    {guide.approaches.bullets && (
                      <ul className="space-y-1.5 ml-0.5">
                        {guide.approaches.bullets.map((b) => (
                          <li
                            key={b}
                            className="flex gap-2.5 text-sm text-muted-foreground"
                          >
                            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/25" />
                            <span>
                              <InlineMarkdown text={b} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <ApproachTable table={guide.approaches} />
                    {guide.approaches.closing && (
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {guide.approaches.closing}
                      </p>
                    )}
                  </section>
                )}

                {hasApproachSections ? (
                  /* ── Per-approach sections (e.g. agent-cancellation) ── */
                  <>
                    {guide!.approachSections!.map((section) => {
                      const sectionBlocks = section.snippetLabels
                        .map((label) => conceptBlocksByLabel.get(label))
                        .filter(
                          (b): b is (typeof conceptBlocks)[number] =>
                            b !== undefined
                        );

                      return (
                        <section
                          key={section.title}
                          id={slugify(section.title)}
                          className="space-y-4"
                        >
                          <h2 className="font-semibold text-2xl tracking-tight">
                            {section.title}
                          </h2>

                          {section.description && (
                            <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
                              <InlineMarkdown text={section.description} />
                            </p>
                          )}

                          {section.installSlug && (
                            <div className="space-y-2">
                              <p className="text-sm text-muted-foreground">
                                Install with the shadcn CLI — the code is copied
                                into your project and you own it from day one.
                              </p>
                              <RegistryInstallTabs slug={section.installSlug} />
                            </div>
                          )}

                          {sectionBlocks.length > 0 && (
                            <RegistryCodeTabs blocks={sectionBlocks} />
                          )}

                          {section.afterBullets &&
                            section.afterBullets.length > 0 && (
                              <ul className="space-y-1.5 ml-0.5">
                                {section.afterBullets.map((b) => (
                                  <li
                                    key={b}
                                    className="flex gap-2.5 text-sm text-muted-foreground"
                                  >
                                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/25" />
                                    <span>
                                      <InlineMarkdown text={b} />
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}

                          {section.afterProse && (
                            <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
                              {section.afterProse}
                            </p>
                          )}

                          {section.callout && (
                            <GuideCallout callout={section.callout} />
                          )}
                        </section>
                      );
                    })}
                  </>
                ) : (
                  /* ── flatLayout without per-approach sections: Installation + Source ── */
                  <>
                    <section id="installation" className="space-y-3">
                      <h2 className="font-semibold text-2xl tracking-tight">
                        Installation
                      </h2>
                      <p className="text-sm text-muted-foreground max-w-2xl">
                        The shadcn CLI copies every file in this recipe into
                        your project — you own the code after install and can
                        customize it freely.
                      </p>
                      <RegistryInstallTabs slug={item.shadcnSlug} />
                    </section>

                    {conceptBlocks.length > 0 && (
                      <section id="concept" className="space-y-3">
                        <h2 className="font-semibold text-2xl tracking-tight">
                          Concept
                        </h2>
                        <p className="text-sm text-muted-foreground max-w-2xl">
                          A simplified walkthrough of the pattern — good for
                          understanding the shape before looking at the full
                          install.
                        </p>
                        <RegistryCodeTabs blocks={conceptBlocks} />
                      </section>
                    )}

                    <section id="source" className="space-y-3">
                      <h2 className="font-semibold text-2xl tracking-tight">
                        Source
                      </h2>
                      <p className="text-sm text-muted-foreground max-w-2xl">
                        {guide?.sourceDescription ??
                          'A preview of the code that gets copied into your app.'}
                      </p>
                      <RegistryCodeTabs blocks={blocks} />
                    </section>
                  </>
                )}
              </>
            ) : (
              <>
                {/* ── Umbrella Overview (items without flat layout) ── */}
                {guide &&
                  (guide.overview || guide.whenToUse || guide.approaches) && (
                    <section id="overview" className="space-y-6">
                      <h2 className="font-semibold text-2xl tracking-tight">
                        Overview
                      </h2>

                      {guide.overview && (
                        <p className="max-w-3xl text-muted-foreground leading-relaxed">
                          {guide.overview}
                        </p>
                      )}

                      {guide.whenToUse && (
                        <div id="when-to-use" className="space-y-2.5">
                          <h3 className="font-semibold text-base">
                            When to use this
                          </h3>
                          <ul className="space-y-1.5 ml-0.5">
                            {guide.whenToUse.map((tip) => (
                              <li
                                key={tip}
                                className="flex gap-2.5 text-sm text-muted-foreground"
                              >
                                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/25" />
                                <span>
                                  <InlineMarkdown text={tip} />
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {guide.approaches && (
                        <div id="choosing-an-approach" className="space-y-2.5">
                          <h3 className="font-semibold text-base">
                            {guide.approaches.title ?? 'Choosing an approach'}
                          </h3>
                          <ApproachTable table={guide.approaches} />
                        </div>
                      )}
                    </section>
                  )}

                {/* ── Installation ── */}
                <section id="installation" className="space-y-3">
                  <h2 className="font-semibold text-2xl tracking-tight">
                    Installation
                  </h2>
                  <p className="text-sm text-muted-foreground max-w-2xl">
                    The shadcn CLI copies every file in this recipe into your
                    project — you own the code after install and can customize
                    it freely.
                  </p>
                  <RegistryInstallTabs slug={item.shadcnSlug} />
                </section>

                {/* ── Concept snippets (when educational ≠ plug-and-play) ── */}
                {conceptBlocks.length > 0 && (
                  <section id="concept" className="space-y-3">
                    <h2 className="font-semibold text-2xl tracking-tight">
                      Concept
                    </h2>
                    <p className="text-sm text-muted-foreground max-w-2xl">
                      A simplified walkthrough of the pattern — good for
                      understanding the shape before looking at the full
                      install.
                    </p>
                    <RegistryCodeTabs blocks={conceptBlocks} />
                  </section>
                )}

                {/* ── Source snippets ── */}
                <section id="source" className="space-y-3">
                  <h2 className="font-semibold text-2xl tracking-tight">
                    Source
                  </h2>
                  <p className="text-sm text-muted-foreground max-w-2xl">
                    {guide?.sourceDescription ??
                      'A preview of the code that gets copied into your app.'}
                  </p>
                  <RegistryCodeTabs blocks={blocks} />
                </section>
              </>
            )}

            {/* ── GUIDE: How it works ── */}
            {guide?.howItWorks && guide.howItWorks.length > 0 && (
              <section id="how-it-works" className="space-y-3">
                <h2 className="font-semibold text-2xl tracking-tight">
                  How it works
                </h2>
                <ol className="space-y-2 ml-0.5 list-none counter-reset-[steps]">
                  {guide.howItWorks.map((step, i) => (
                    <li
                      key={step}
                      className="flex gap-3 text-sm text-muted-foreground"
                    >
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground">
                        {i + 1}
                      </span>
                      <span>
                        <InlineMarkdown text={step} />
                      </span>
                    </li>
                  ))}
                </ol>
                {guide.howItWorksClosing && (
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    <InlineMarkdown text={guide.howItWorksClosing} />
                  </p>
                )}
              </section>
            )}

            {/* ── GUIDE: Adapting ── */}
            {guide?.adapting && guide.adapting.length > 0 && (
              <section id="adapting-this" className="space-y-3">
                <h2 className="font-semibold text-2xl tracking-tight">
                  {guide.adaptingTitle ?? 'Adapting this'}
                </h2>
                {guide.adaptingIntro && (
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {guide.adaptingIntro}
                  </p>
                )}
                <ul className="space-y-1.5 ml-0.5">
                  {guide.adapting.map((tip) => (
                    <li
                      key={tip}
                      className="flex gap-2.5 text-sm text-muted-foreground"
                    >
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/25" />
                      <span>
                        <InlineMarkdown text={tip} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── GUIDE: Key APIs ── */}
            {guide?.keyApis && guide.keyApis.length > 0 && (
              <section id="key-apis" className="space-y-3">
                <h2 className="font-semibold text-2xl tracking-tight">
                  Key APIs
                </h2>
                <ul className="flex flex-wrap gap-2">
                  {guide.keyApis.map((api) => (
                    <li key={api.label}>
                      <a
                        href={api.url}
                        className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 font-mono text-sm text-foreground hover:bg-accent transition-colors"
                      >
                        {api.label}
                        <ExternalLink className="size-3 text-muted-foreground" />
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </main>

          {/* ── ToC sidebar ── */}
          <aside className="hidden lg:block pt-10 sm:pt-12">
            <div className="sticky top-24">
              <RegistryDetailToc
                items={tocItems}
                pageText={pageText}
                href={`/patterns/${id}`}
                githubPath="manifest.ts"
              />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Converts an approach section title to a URL-safe anchor id. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Renders inline **bold** and `code` markers within a string.
 * Used for bullet lists and table cells throughout the guide sections.
 */
function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={i} className="font-semibold text-foreground">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code
              key={i}
              className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8em] text-foreground"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          return (
            <a
              key={i}
              href={linkMatch[2]}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              {linkMatch[1]}
            </a>
          );
        }
        return part;
      })}
    </>
  );
}

/** Kept for the ApproachTable which only needs code spans, not bold. */
const InlineCode = ({ text }: { text: string }) => (
  <InlineMarkdown text={text} />
);

function ApproachTable({
  table,
}: {
  table: NonNullable<RegistryGuide['approaches']>;
}) {
  // columns[0] is the row-label column header (often empty); rest are approach names
  const [, ...approachNames] = table.columns;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 divide-x divide-border">
            {/* Empty first header — no text, just a spacer */}
            <th className="w-44 px-4 py-2.5" />
            {approachNames.map((name) => (
              <th
                key={name}
                className="px-4 py-2.5 text-left font-semibold text-foreground"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr
              key={row.aspect}
              className="border-b last:border-0 divide-x divide-border"
            >
              <td className="px-4 py-3 text-sm font-medium text-foreground/80">
                <InlineCode text={row.aspect} />
              </td>
              {row.values.map((val, ci) => (
                <td
                  key={`${row.aspect}-${approachNames[ci]}`}
                  className="px-4 py-3 text-sm text-muted-foreground"
                >
                  <InlineCode text={val} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const calloutStyles = {
  // blue/emerald use Tailwind's default palette (not overridden by Geist), so
  // explicit dark: overrides with high-numbered shades work as expected.
  info: {
    container: 'border-blue-300 bg-blue-100 dark:border-blue-500',
    icon: <Info className="size-4 text-blue-700 shrink-0 mt-0.5" />,
    text: 'text-blue-1000',
  },
  // amber IS overridden by the Geist DS — the scale is inverted in dark mode:
  // amber-100 ≈ near-black, amber-1000 ≈ near-white. Use semantic shades and
  // let the CSS vars handle the theme switch automatically.
  warn: {
    container: 'border-amber-300 bg-amber-100 dark:border-amber-500',
    icon: <AlertTriangle className="size-4 text-amber-700 shrink-0 mt-0.5" />,
    text: 'text-amber-1000',
  },
  tip: {
    container: 'border-emerald-300 bg-emerald-100 dark:border-emerald-500',
    icon: <Lightbulb className="size-4 text-emerald-700 shrink-0 mt-0.5" />,
    text: 'text-emerald-1000',
  },
};

function GuideCallout({
  callout,
}: {
  callout: NonNullable<RegistryGuide['callout']>;
}) {
  const styles = calloutStyles[callout.type];
  return (
    <div className={cn('flex gap-2.5 rounded-md border p-4', styles.container)}>
      {styles.icon}
      <p className={cn('text-sm leading-relaxed', styles.text)}>
        <InlineMarkdown text={callout.content} />
      </p>
    </div>
  );
}
