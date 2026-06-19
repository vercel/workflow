import { runInContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext } from './index.js';
import {
  clearWorkflowScriptCache,
  getCachedWorkflowScript,
  runCachedWorkflowScript,
  workflowScriptCacheSize,
} from './script-cache.js';

const seed = 'script-cache seed';
const fixedTimestamp = 1234567890000;

const SAMPLE_BUNDLE = `
globalThis.__private_workflows = new Map();
globalThis.__private_workflows.set('my/workflow', async function workflow(name) {
  return 'hello,' + name + ',' + Math.random() + ',' + Date.now();
});
`;

/**
 * Builds a realistic multi-workflow bundle: many registered workflow functions
 * (the production shape) with a distinguishing `marker` baked in so two bundles
 * built with different markers are genuinely different code (not the trivial
 * `1 + 1` / `2 + 2` strings). Each workflow returns a value derived from the
 * marker so a mis-served Script would produce a detectably wrong result.
 */
function buildBundle(marker: string, workflowCount = 12): string {
  const defs: string[] = [];
  for (let i = 0; i < workflowCount; i++) {
    defs.push(
      `globalThis.__private_workflows.set('app/workflow-${i}', async function workflow${i}(name) {\n` +
        `  return '${marker}:' + ${i} + ':' + name + ':' + Math.random();\n` +
        `});`
    );
  }
  return `globalThis.__private_workflows = new Map();\n${defs.join('\n')}\n`;
}

describe('script-cache', () => {
  afterEach(() => {
    clearWorkflowScriptCache();
  });

  it('returns the same compiled Script for identical (code, filename)', () => {
    const a = getCachedWorkflowScript(SAMPLE_BUNDLE, 'workflows/a.ts');
    const b = getCachedWorkflowScript(SAMPLE_BUNDLE, 'workflows/a.ts');
    expect(a).toBe(b);
  });

  it('returns distinct Scripts for the same code under different filenames', () => {
    const a = getCachedWorkflowScript(SAMPLE_BUNDLE, 'workflows/a.ts');
    const b = getCachedWorkflowScript(SAMPLE_BUNDLE, 'workflows/b.ts');
    expect(a).not.toBe(b);
  });

  it('returns distinct Scripts for different code under the same filename', () => {
    const a = getCachedWorkflowScript('1 + 1', 'workflows/a.ts');
    const b = getCachedWorkflowScript('2 + 2', 'workflows/a.ts');
    expect(a).not.toBe(b);
  });

  it('produces a byte-identical workflow result vs. uncached runInContext', async () => {
    // Cached path: run the bundle then look up the workflow, mirroring
    // runWorkflow's two-step evaluation.
    const { context: cachedCtx } = createContext({ seed, fixedTimestamp });
    runCachedWorkflowScript(SAMPLE_BUNDLE, 'workflows/a.ts', cachedCtx);
    const cachedFn = runCachedWorkflowScript(
      `globalThis.__private_workflows?.get('my/workflow')`,
      'workflows/a.ts',
      cachedCtx
    );
    expect(cachedFn).toBeTypeOf('function');
    const cachedResult = await (cachedFn as (n: string) => Promise<string>)(
      'world'
    );

    // Uncached path: the original combined-string approach.
    const { context: plainCtx } = createContext({ seed, fixedTimestamp });
    const plainFn = runInContext(
      `${SAMPLE_BUNDLE}; globalThis.__private_workflows?.get('my/workflow')`,
      plainCtx,
      { filename: 'workflows/a.ts' }
    );
    const plainResult = await (plainFn as (n: string) => Promise<string>)(
      'world'
    );

    expect(cachedResult).toEqual(plainResult);
  });

  it('reuses the compiled Script across multiple runs against fresh contexts', async () => {
    const script = getCachedWorkflowScript(SAMPLE_BUNDLE, 'workflows/a.ts');

    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { context } = createContext({ seed, fixedTimestamp });
      runCachedWorkflowScript(SAMPLE_BUNDLE, 'workflows/a.ts', context);
      // The same cached Script object is used every iteration.
      expect(getCachedWorkflowScript(SAMPLE_BUNDLE, 'workflows/a.ts')).toBe(
        script
      );
      const fn = runInContext(
        `globalThis.__private_workflows?.get('my/workflow')`,
        context
      ) as (n: string) => Promise<string>;
      results.push(await fn('world'));
    }

    // Deterministic context => identical results every run.
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });

  it('bounds the bundle cache and evicts least-recently-used bundles', () => {
    // Insert far more distinct bundles than any sane cap, simulating a long
    // dev/watch session where every edit produces a new bundle string. The
    // cache must NOT grow monotonically with edit count.
    const editCount = 100;
    const filename = 'workflows/a.ts';
    for (let i = 0; i < editCount; i++) {
      getCachedWorkflowScript(buildBundle(`edit-${i}`), filename);
    }

    const size = workflowScriptCacheSize();
    expect(size).toBeGreaterThan(0);
    // Bounded well below the number of edits — the whole point of the LRU.
    expect(size).toBeLessThan(editCount);

    // The cache still serves correctly after heavy churn: the most-recently
    // inserted bundle is retained and repeated lookups return the same Script.
    const latest = buildBundle(`edit-${editCount - 1}`);
    expect(getCachedWorkflowScript(latest, filename)).toBe(
      getCachedWorkflowScript(latest, filename)
    );
  });

  it('keeps the most-recently-used bundle and evicts the stale one', () => {
    const filename = 'workflows/a.ts';
    // Seed an "old" bundle, then keep it hot by re-touching it while many
    // unrelated bundles churn through. LRU must NOT evict the bundle we keep
    // using, even though it was inserted first.
    const hot = buildBundle('hot');
    const hotScript = getCachedWorkflowScript(hot, filename);

    for (let i = 0; i < 50; i++) {
      getCachedWorkflowScript(buildBundle(`cold-${i}`), filename);
      // Re-access the hot bundle so it stays most-recently-used.
      expect(getCachedWorkflowScript(hot, filename)).toBe(hotScript);
    }

    // After all that churn the hot bundle is still the *same* cached Script —
    // proving LRU recency (touch-on-access), not mere insertion order, governs
    // eviction.
    expect(getCachedWorkflowScript(hot, filename)).toBe(hotScript);
  });

  it('never returns the wrong Script across realistic multi-workflow bundles', async () => {
    // Two genuinely different bundles (production-shape: many workflows each),
    // distinguished by their marker, plus two filenames. Every distinct
    // (code, filename) must map to its own Script, and running each must
    // produce results derived from its own marker — never another bundle's.
    const bundleX = buildBundle('bundle-X');
    const bundleY = buildBundle('bundle-Y');
    const fileA = 'workflows/a.ts';
    const fileB = 'workflows/b.ts';

    const xa = getCachedWorkflowScript(bundleX, fileA);
    const xb = getCachedWorkflowScript(bundleX, fileB);
    const ya = getCachedWorkflowScript(bundleY, fileA);
    const yb = getCachedWorkflowScript(bundleY, fileB);

    // All four (code, filename) combinations are distinct Script objects.
    const scripts = [xa, xb, ya, yb];
    for (let i = 0; i < scripts.length; i++) {
      for (let j = i + 1; j < scripts.length; j++) {
        expect(scripts[i]).not.toBe(scripts[j]);
      }
    }

    // Same (code, filename) is stable across lookups.
    expect(getCachedWorkflowScript(bundleX, fileA)).toBe(xa);
    expect(getCachedWorkflowScript(bundleY, fileB)).toBe(yb);

    // Running each bundle yields its OWN marker, confirming no cross-wiring.
    const { context: ctxX } = createContext({ seed, fixedTimestamp });
    runCachedWorkflowScript(bundleX, fileA, ctxX);
    const fnX = runInContext(
      `globalThis.__private_workflows?.get('app/workflow-3')`,
      ctxX
    ) as (n: string) => Promise<string>;
    expect(await fnX('z')).toContain('bundle-X:3:z');

    const { context: ctxY } = createContext({ seed, fixedTimestamp });
    runCachedWorkflowScript(bundleY, fileA, ctxY);
    const fnY = runInContext(
      `globalThis.__private_workflows?.get('app/workflow-3')`,
      ctxY
    ) as (n: string) => Promise<string>;
    expect(await fnY('z')).toContain('bundle-Y:3:z');
  });
});
