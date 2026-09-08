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
 * The Vercel World's per-run event ceiling happens to equal the SDK's own
 * default for the Local World, so this constant is the number user-facing docs
 * are most likely to hardcode by mistake.
 */
function runtimeEventCeiling(): number {
  const source = read('packages/world/src/env-config.ts');
  const match = /const DEFAULT_MAX_EVENTS_PER_RUN = ([\d_]+);/.exec(source);
  if (!match) {
    throw new Error(
      'Could not find DEFAULT_MAX_EVENTS_PER_RUN in packages/world/src/env-config.ts. ' +
        'If the constant moved, update this guard too.'
    );
  }
  return Number(match[1].replaceAll('_', ''));
}

/**
 * Pages that present the per-run event ceiling to users. Each must point at the
 * pricing page, either directly or through the Vercel World's section, so the
 * published number stays the single source of truth.
 */
const PAGES_PRESENTING_THE_CEILING = [
  'docs/content/worlds/v5/vercel.mdx',
  'docs/content/docs/v5/how-it-works/event-sourcing.mdx',
  'docs/content/docs/v5/cookbook/advanced/child-workflows.mdx',
  'docs/content/docs/v5/cookbook/common-patterns/batching.mdx',
  'docs/content/docs/v5/foundations/errors-and-retries.mdx',
  'docs/content/docs/v5/whats-new.mdx',
];

const VERCEL_WORLD_LIMIT_ANCHOR = '/worlds/vercel#per-run-event-limit';

/**
 * `configuration/` documents `WORKFLOW_MAX_EVENTS`, an SDK-owned env var whose
 * default legitimately appears as a number. Everything else is prose about the
 * managed ceiling, which must defer to the pricing page instead.
 */
const CONFIG_REFERENCE_PAGES = new Set([
  'docs/content/docs/v5/configuration/runtime-tuning.mdx',
  'docs/content/docs/v5/configuration/worlds.mdx',
]);

function userFacingDocPages(): string[] {
  return globSync(
    ['docs/content/docs/v5/**/*.mdx', 'docs/content/worlds/v5/**/*.mdx'],
    { cwd: repoRoot }
  )
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => !CONFIG_REFERENCE_PAGES.has(file));
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
        `${page} discusses the per-run event ceiling, so it must link ${PRICING_LIMITS_URL} or ${VERCEL_WORLD_LIMIT_ANCHOR}`
      ).toBe(true);
    }
  });

  it('does not hardcode the ceiling outside the env-var reference', () => {
    const ceiling = runtimeEventCeiling();
    const forbidden = [ceiling.toLocaleString('en-US'), String(ceiling)];
    for (const page of userFacingDocPages()) {
      const text = read(page);
      for (const literal of forbidden) {
        expect(
          text,
          `${page} should defer to ${PRICING_LIMITS_URL} rather than state "${literal}"`
        ).not.toContain(literal);
      }
    }
  });

  it('keeps the concurrency heuristic in the skill only', () => {
    // The "~1000 steps in flight" figure is a rule of thumb for agents, not a
    // published limit, so it belongs in the skill rather than in the docs.
    expect(read('skills/workflow/SKILL.md')).toContain('~1000');
    for (const page of userFacingDocPages()) {
      expect(
        read(page),
        `${page} should describe high concurrency qualitatively, without the ~1000 rule of thumb`
      ).not.toContain('~1000');
    }
  });
});
