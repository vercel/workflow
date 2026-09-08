import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

/**
 * Sources of the per-run event ceiling, and the pages that quote it.
 *
 * The number is a scale limit users design against — "split into child
 * workflows before you get near it" is only actionable if the figure in the
 * docs is the figure the runtime enforces. Nothing else couples the two, so
 * this guard fails when one moves without the other.
 */
const LIMIT_SOURCES = [
  {
    file: 'packages/world/src/env-config.ts',
    pattern: /const DEFAULT_MAX_EVENTS_PER_RUN = ([\d_]+);/,
  },
  {
    file: 'packages/world-sim/src/store.ts',
    pattern: /const MAX_EVENTS_PER_RUN = ([\d_]+);/,
  },
] as const;

/** Agent-facing pages that state the ceiling in prose. */
const PAGES_QUOTING_THE_LIMIT = [
  'docs/content/docs/v5/foundations/workflows-and-steps.mdx',
  'docs/content/docs/v5/how-it-works/event-sourcing.mdx',
  'docs/content/docs/v5/cookbook/advanced/child-workflows.mdx',
  'docs/content/docs/v5/cookbook/common-patterns/batching.mdx',
  'docs/content/worlds/v5/vercel.mdx',
  'skills/workflow/SKILL.md',
];

function readLimit(source: (typeof LIMIT_SOURCES)[number]): number {
  const match = source.pattern.exec(read(source.file));
  if (!match) {
    throw new Error(
      `Could not find the per-run event ceiling in ${source.file}. ` +
        'If the constant was renamed or moved, update LIMIT_SOURCES here too.'
    );
  }
  return Number(match[1].replaceAll('_', ''));
}

describe('per-run event ceiling', () => {
  const [runtimeLimit, ...otherLimits] = LIMIT_SOURCES.map(readLimit);

  it('is the same number in every world that declares it', () => {
    for (const limit of otherLimits) {
      expect(limit).toBe(runtimeLimit);
    }
  });

  it('is quoted verbatim by the docs that tell users to split runs', () => {
    const formatted = runtimeLimit.toLocaleString('en-US');
    for (const page of PAGES_QUOTING_THE_LIMIT) {
      expect(read(page), `${page} should state ${formatted} events`).toContain(
        formatted
      );
    }
  });

  it('still supports the "roughly 8,000 steps" figure those pages derive', () => {
    // A step that succeeds on the first attempt records three events:
    // step_created, step_started, step_completed.
    const stepsUntilFull = runtimeLimit / 3;
    expect(Math.round(stepsUntilFull / 1000) * 1000).toBe(8000);
  });
});
