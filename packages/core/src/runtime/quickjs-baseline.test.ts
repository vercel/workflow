/**
 * The QuickJS baseline heap (the workflow bundle evaluated before any run)
 * must be reproducible: the build prebuilds it, and per-run snapshots are
 * compressed against it, which only works when every instance of a
 * deployment derives the same bytes.
 */
import { afterEach, assert, describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import {
  __clearBaselineSnapshotCacheForTests,
  __peekBaselineEntryForTests,
  createPrebuiltQuickJSBaseline,
  getQuickJSBaselineDictionary,
  QUICKJS_BASELINE_ASSET,
  quickjsBaselineEngineId,
  registerPrebuiltQuickJSBaseline,
  startQuickJSWorkflow,
} from './quickjs-runtime.js';

const workflowCode = `
  var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//add");
  var table = [];
  for (var i = 0; i < 2000; i++) table.push({ i: i, label: "row " + i });
  async function workflow(a, b) {
    return (await add(a, b)) + table.length;
  }
  globalThis.__private_workflows.set("workflow//test//workflow", workflow);
`;

function makeRun() {
  return {
    runId: 'wrun_baseline',
    deploymentId: 'dpl_test',
    workflowName: 'test-workflow',
    input: undefined,
    status: 'running' as const,
    output: undefined,
    error: undefined,
    completedAt: undefined,
    startedAt: new Date('2025-01-01T00:00:00Z'),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    specVersion: 2,
  };
}

/** Run the workflow to completion, returning its result. */
async function run(code = workflowCode): Promise<unknown> {
  const run = makeRun();
  const session = await startQuickJSWorkflow({
    workflowCode: code,
    workflowId: 'workflow//test//workflow',
    workflowRun: run,
    events: [
      {
        eventId: 'evnt_run_created',
        runId: run.runId,
        eventType: 'run_created',
        eventData: { input: serialize([2, 3]) },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
    ] as never,
  });
  let result = session.result;
  if (result.suspended) {
    const cid = result.suspended.pendingOperations[0].correlationId;
    result = await session.continueWithEvents([
      {
        eventId: 'evnt_c',
        runId: run.runId,
        eventType: 'step_created',
        correlationId: cid,
        eventData: { stepName: 'step//test//add' },
        createdAt: new Date('2025-01-01T00:00:01Z'),
      },
      {
        eventId: 'evnt_d',
        runId: run.runId,
        eventType: 'step_completed',
        correlationId: cid,
        eventData: { result: serialize(5) },
        createdAt: new Date('2025-01-01T00:00:02Z'),
      },
    ] as never);
  }
  session.dispose();
  if (!result.completed) throw new Error(JSON.stringify(result.failed));
  return deserialize(result.completed.result);
}

afterEach(() => {
  __clearBaselineSnapshotCacheForTests();
});

describe('QuickJS baseline heap', () => {
  it('is byte-identical across independent hydrates', async () => {
    const first = await getQuickJSBaselineDictionary(workflowCode, 'w');
    __clearBaselineSnapshotCacheForTests();
    // A different wall clock: the hydrate must not observe it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await getQuickJSBaselineDictionary(workflowCode, 'w');
    expect(first).toBeDefined();
    expect(second?.digest).toBe(first?.digest);
    expect(first && second && Buffer.compare(second.bytes, first.bytes)).toBe(
      0
    );
  });

  it('has no dictionary for a bundle whose module scope draws randomness', async () => {
    const code = `${workflowCode}\nvar seed = Math.random();`;
    expect(await getQuickJSBaselineDictionary(code, 'w')).toBeUndefined();
  });

  describe('prebuilt', () => {
    /** Build it, and a loader that serves its asset like a deployment would. */
    async function prebuild(code = workflowCode) {
      const build = await createPrebuiltQuickJSBaseline(code);
      assert(build);
      const reads: string[] = [];
      const loadAsset = async (name: string) => {
        reads.push(name);
        if (name !== QUICKJS_BASELINE_ASSET || !build.asset) {
          throw new Error(`ENOENT: ${name}`);
        }
        return build.asset;
      };
      __clearBaselineSnapshotCacheForTests();
      return { ...build, loadAsset, reads };
    }

    it('matches the heap an instance hydrates, and is used instead of hydrating', async () => {
      const hydrated = await getQuickJSBaselineDictionary(workflowCode, 'w');
      const { header, asset, loadAsset, reads } = await prebuild();
      expect(header).toMatchObject({
        v: 2,
        engineId: quickjsBaselineEngineId(),
      });
      expect(header.ineligible).toBeUndefined();
      expect(header.digest).toBe(hydrated?.digest);
      // The asset is compressed.
      expect(asset?.byteLength).toBeLessThan(
        (hydrated?.bytes.byteLength ?? 0) / 2
      );

      registerPrebuiltQuickJSBaseline(header, loadAsset);
      expect(await run()).toBe(2005);
      expect(reads).toEqual([QUICKJS_BASELINE_ASSET]);
      // A hydrated entry computes its dictionary lazily; a prebuilt one
      // arrives with it.
      const entry = await __peekBaselineEntryForTests(workflowCode);
      expect(entry).toMatchObject({
        state: 'ready',
        dictionary: { digest: header.digest },
      });
    });

    it('is read at most once per process', async () => {
      const { header, loadAsset, reads } = await prebuild();
      registerPrebuiltQuickJSBaseline(header, loadAsset);
      expect(await run()).toBe(2005);
      expect(await run()).toBe(2005);
      expect(reads).toHaveLength(1);
    });

    it.each([
      ['built by different engine code', { engineId: 'other' }, false],
      ['corrupt', { digest: '0'.repeat(64) }, true],
    ])('is ignored when %s', async (_name, override, reads) => {
      const { header, loadAsset, reads: read } = await prebuild();
      registerPrebuiltQuickJSBaseline({ ...header, ...override }, loadAsset);
      expect(await run()).toBe(2005);
      // An engine mismatch is decided from the header alone.
      expect(read.length > 0).toBe(reads);
      const entry = await __peekBaselineEntryForTests(workflowCode);
      expect(entry?.state).toBe('ready');
      expect(entry && 'dictionary' in entry && entry.dictionary).toBeFalsy();
    });

    it.each([
      ['its asset cannot be read', true],
      ['there is no asset loader', false],
    ])('falls back to hydrating when %s', async (_name, withLoader) => {
      const { header } = await prebuild();
      registerPrebuiltQuickJSBaseline(
        header,
        withLoader
          ? async () => {
              throw new Error('ENOENT');
            }
          : undefined
      );
      expect(await run()).toBe(2005);
      const entry = await __peekBaselineEntryForTests(workflowCode);
      expect(entry?.state).toBe('ready');
      expect(entry && 'dictionary' in entry && entry.dictionary).toBeFalsy();
    });

    it('records an ineligible bundle so instances skip the hydrate', async () => {
      const code = `${workflowCode}\nvar startedAt = Date.now();`;
      const { header, asset, error, loadAsset, reads } = await prebuild(code);
      expect(header.ineligible).toMatch(/clock read/);
      expect(asset).toBeUndefined();
      expect(error).toBeUndefined();
      registerPrebuiltQuickJSBaseline(header, loadAsset);
      expect(await run(code)).toBe(2005);
      expect(reads).toEqual([]);
      expect(await __peekBaselineEntryForTests(code)).toEqual({
        state: 'ineligible',
        reason: header.ineligible,
      });
    });

    it('reports what module scope threw', async () => {
      const code = `${workflowCode}\nnew Intl.NumberFormat("en-US");`;
      const { header, asset, error } = await prebuild(code);
      expect(asset).toBeUndefined();
      expect(header.ineligible).toMatch(/module scope threw/);
      expect(error).toMatchObject({
        name: 'WorkflowRuntimeError',
        message: expect.stringContaining('Intl.NumberFormat'),
      });
      expect(error?.stack).toEqual(expect.any(String));
    });

    it('does not apply to other workflow code', async () => {
      const { header, loadAsset, reads } = await prebuild();
      registerPrebuiltQuickJSBaseline(header, loadAsset);
      const other = `${workflowCode}\n// another deployment`;
      expect(await run(other)).toBe(2005);
      expect(reads).toEqual([]);
      const entry = await __peekBaselineEntryForTests(other);
      expect(entry && 'dictionary' in entry && entry.dictionary).toBeFalsy();
    });
  });
});
