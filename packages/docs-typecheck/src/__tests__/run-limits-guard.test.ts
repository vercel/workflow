import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

/** The authoritative source for the Vercel World's per-run limits. */
const PRICING_LIMITS_URL =
  'https://vercel.com/docs/workflows/pricing#workflow-run-limits';

/**
 * The Vercel World's per-run ceilings are service-owned and published on the
 * pricing page; nothing in this repository holds them. These are the spellings
 * a doc page would reach for if it tried to restate the event ceiling in prose
 * instead of linking. The numeric-separator form (`25_000`) is deliberately
 * absent: it only shows up inside code samples, where an unrelated `25_000`
 * timeout is legitimate.
 *
 * This list is deliberately literal rather than derived from
 * `DEFAULT_MAX_EVENTS_PER_RUN`: that constant is the Local World's SDK default,
 * which only happens to match the managed ceiling today. Deriving from it would
 * mean that bumping an SDK default silently re-points this guard at the wrong
 * number and stops guarding the real one.
 */
const FORBIDDEN_CEILING_SPELLINGS = ['25,000', '25000', '25K', '25k'];

/**
 * Pages that present the per-run limits to users. Each must point at the
 * pricing page, either directly or through the Vercel World's section, so the
 * published numbers stay the single source of truth.
 */
const PAGES_PRESENTING_THE_CEILING = [
  'docs/content/worlds/v5/vercel.mdx',
  'docs/content/docs/v5/how-it-works/event-sourcing.mdx',
  'docs/content/docs/v5/cookbook/advanced/child-workflows.mdx',
  'docs/content/docs/v5/cookbook/common-patterns/batching.mdx',
  'docs/content/docs/v5/cookbook/common-patterns/sequential-and-parallel.mdx',
  'docs/content/docs/v5/foundations/errors-and-retries.mdx',
  'docs/content/docs/v5/whats-new.mdx',
];

const VERCEL_WORLD_LIMITS_PAGE = 'docs/content/worlds/v5/vercel.mdx';
const VERCEL_WORLD_LIMIT_ANCHOR = '/worlds/vercel#per-run-limits';

/**
 * `configuration/` documents `WORKFLOW_MAX_EVENTS`, an SDK-owned env var whose
 * default legitimately appears as a number. `comparisons/` quotes other
 * vendors' published limits, which are theirs to state. Everything else is
 * prose about the managed ceiling, which must defer to the pricing page.
 */
const PAGES_ALLOWED_TO_STATE_NUMBERS = new Set([
  'docs/content/docs/v5/configuration/runtime-tuning.mdx',
  'docs/content/docs/v5/configuration/worlds.mdx',
]);

const isComparisonPage = (file: string) => file.includes('/comparisons/');

/**
 * Every published docs tree, not just v5: an older tree stays online, and a
 * newer one must not start out unguarded.
 */
function userFacingDocPages(): string[] {
  return globSync(
    ['docs/content/docs/**/*.mdx', 'docs/content/worlds/**/*.mdx'],
    {
      cwd: repoRoot,
    }
  )
    .map((file) => file.split(path.sep).join('/'))
    .filter(
      (file) =>
        !PAGES_ALLOWED_TO_STATE_NUMBERS.has(file) && !isComparisonPage(file)
    );
}

/** Heading slugs, matching the `#anchor` form the docs site generates. */
function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (!heading) continue;
    slugs.add(
      heading[1]
        .replace(/`/g, '')
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
    );
  }
  return slugs;
}

describe('run-limit guidance in user-facing docs', () => {
  it('routes readers to the pricing page for the ceiling', () => {
    for (const page of PAGES_PRESENTING_THE_CEILING) {
      const text = read(page);
      const defersToPricing =
        text.includes(PRICING_LIMITS_URL) ||
        text.includes(VERCEL_WORLD_LIMIT_ANCHOR);
      expect(
        defersToPricing,
        `${page} discusses the per-run limits, so it must link ${PRICING_LIMITS_URL} or ${VERCEL_WORLD_LIMIT_ANCHOR}`
      ).toBe(true);
    }
  });

  it('keeps the Vercel World limits anchor resolvable', () => {
    // Every page above may point at VERCEL_WORLD_LIMIT_ANCHOR instead of the
    // pricing page, so renaming that heading would silently break the hub the
    // rest of this guidance hangs off.
    const anchor = VERCEL_WORLD_LIMIT_ANCHOR.split('#')[1];
    expect(
      headingSlugs(read(VERCEL_WORLD_LIMITS_PAGE)),
      `${VERCEL_WORLD_LIMITS_PAGE} must keep a heading that slugifies to "#${anchor}", because other pages link to it`
    ).toContain(anchor);
  });

  it('resolves every in-repo docs anchor it points at', () => {
    // Guards the links this guidance adds between pages: a renamed heading
    // should fail here rather than ship as a dead in-page jump.
    const pageForRoute = (route: string): string | undefined => {
      const candidates = [
        `docs/content/docs/v5${route.replace(/^\/docs/, '')}.mdx`,
        `docs/content/docs/v5${route.replace(/^\/docs/, '')}/index.mdx`,
        `docs/content/worlds/v5${route.replace(/^\/worlds/, '')}.mdx`,
        `docs/content/docs/v5${route}.mdx`,
        `docs/content/docs/v5${route}/index.mdx`,
      ];
      return candidates.find((candidate) =>
        fs.existsSync(path.join(repoRoot, candidate))
      );
    };

    for (const page of PAGES_PRESENTING_THE_CEILING) {
      const text = read(page);
      for (const [, route, anchor] of text.matchAll(
        /\]\((\/[\w\-/]+)#([\w-]+)\)/g
      )) {
        const target = pageForRoute(route);
        expect(
          target,
          `${page} links ${route}#${anchor}, which is not a docs page`
        ).toBeDefined();
        expect(
          headingSlugs(read(target as string)),
          `${page} links ${route}#${anchor}, but ${target} has no heading with that slug`
        ).toContain(anchor);
      }
    }
  });

  it('does not restate the managed ceiling outside the env-var reference', () => {
    for (const page of userFacingDocPages()) {
      const text = read(page);
      for (const literal of FORBIDDEN_CEILING_SPELLINGS) {
        expect(
          text,
          `${page} should defer to ${PRICING_LIMITS_URL} rather than state "${literal}"`
        ).not.toContain(literal);
      }
    }
  });

  it('describes run size qualitatively, with no invented thresholds', () => {
    // The guidance is deliberately unnumbered: "a few thousand events" tracks
    // the pricing page's own child-workflow recommendation. Earlier drafts of
    // this guidance carried a "~100", then "~1000", steps-in-flight rule of
    // thumb with no published source behind it; neither should come back.
    // Scoped to the pages carrying this guidance: elsewhere in the docs a
    // "~24 concurrent polls" style figure can be a real measurement.
    const inventedThreshold =
      /~\s*\d+\s*(?:steps|concurrent|in flight|parallel)/i;
    for (const page of [
      ...PAGES_PRESENTING_THE_CEILING,
      'skills/workflow/SKILL.md',
    ]) {
      expect(
        read(page),
        `${page} should describe run size and concurrency qualitatively, without an unsourced steps-in-flight rule of thumb`
      ).not.toMatch(inventedThreshold);
    }
  });

  it('tells agents that the step ceiling exists too', () => {
    // The skill previously said deep runs were unbounded. Steps per run are
    // capped separately from events, so the skill must size both.
    const skill = read('skills/workflow/SKILL.md');
    expect(skill).toContain(PRICING_LIMITS_URL);
    expect(
      skill.toLowerCase(),
      'skills/workflow/SKILL.md must tell agents that steps per run are capped, not only events'
    ).toContain('steps per run');
  });
});
