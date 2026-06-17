import { runInContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext } from './index.js';
import {
  clearWorkflowScriptCache,
  getCachedWorkflowScript,
  runCachedWorkflowScript,
} from './script-cache.js';

const seed = 'script-cache seed';
const fixedTimestamp = 1234567890000;

const SAMPLE_BUNDLE = `
globalThis.__private_workflows = new Map();
globalThis.__private_workflows.set('my/workflow', async function workflow(name) {
  return 'hello,' + name + ',' + Math.random() + ',' + Date.now();
});
`;

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
});
