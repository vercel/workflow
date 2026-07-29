import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextStorage } from '../step/context-storage.js';
import { start } from './start.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));

/**
 * Cross-run lineage: start() records reserved `$rootRunId` / `$parentRunId`
 * attributes when it runs inside another run, so a daisy chain or fan-out
 * groups under one root id. The lineage is a pure read of the ambient step
 * context: the runtime fills both the parent run id and its root from the run
 * it already has loaded, so start() never reads back the parent (`runs.get` is
 * never called). A top-level start() records nothing.
 */
describe('start() cross-run lineage', () => {
  let eventsCreate: ReturnType<typeof vi.fn>;
  let runsGet: ReturnType<typeof vi.fn>;
  let queue: ReturnType<typeof vi.fn>;

  // The runtime requires the world to declare the current spec version; the
  // per-run spec is driven separately via `opts.specVersion` where needed.
  function useWorld() {
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
      events: { create: eventsCreate },
      runs: { get: runsGet },
      queue,
    } as any);
  }

  beforeEach(() => {
    eventsCreate = vi.fn().mockImplementation((runId) =>
      Promise.resolve({
        run: { runId: runId ?? 'wrun_x', status: 'pending' },
      })
    );
    runsGet = vi.fn();
    queue = vi.fn().mockResolvedValue(undefined);
    useWorld();
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  const wf = (id: string) =>
    Object.assign(() => Promise.resolve('ok'), { workflowId: id });

  /** Attributes seeded onto the run_created event for the first start() call. */
  function seededAttributes(): Record<string, string> | undefined {
    return eventsCreate.mock.calls[0]?.[1]?.eventData?.attributes;
  }

  /**
   * Run `fn` as if executing inside a parent run's step context. Pass
   * `rootRunId` to model the runtime having put the parent's root on the
   * context (the wired path); omit it to exercise the anchor-to-parent default.
   */
  function insideRun<T>(
    parentRunId: string,
    fn: () => Promise<T>,
    rootRunId?: string
  ): Promise<T> {
    return contextStorage.run(
      {
        stepMetadata: {
          stepName: 'start',
          stepId: 'step_1',
          stepStartedAt: new Date(),
          attempt: 1,
        },
        workflowMetadata: {
          workflowName: 'parent',
          workflowRunId: parentRunId,
          workflowStartedAt: new Date(),
          url: 'http://localhost:3000',
          features: { encryption: false },
        },
        rootRunId,
        ops: [],
      } as any,
      fn
    );
  }

  it('records no lineage for a top-level start()', async () => {
    await start(wf('test-workflow'), []);

    expect(seededAttributes()).toBeUndefined();
    expect(runsGet).not.toHaveBeenCalled();
  });

  it('inherits the root from the context with no read-back', async () => {
    await insideRun(
      'wrun_parent',
      () => start(wf('child-workflow'), []),
      'wrun_root'
    );

    expect(runsGet).not.toHaveBeenCalled();
    expect(seededAttributes()).toEqual({
      $rootRunId: 'wrun_root',
      $parentRunId: 'wrun_parent',
    });
  });

  it('anchors the root to the parent when the context carries none', async () => {
    await insideRun('wrun_parent', () => start(wf('child-workflow'), []));

    expect(runsGet).not.toHaveBeenCalled();
    expect(seededAttributes()).toEqual({
      $rootRunId: 'wrun_parent',
      $parentRunId: 'wrun_parent',
    });
  });

  it('merges caller-provided attributes over the inferred lineage', async () => {
    await insideRun(
      'wrun_parent',
      () => start(wf('child-workflow'), [], { attributes: { tenant: 't1' } }),
      'wrun_root'
    );

    const expected = {
      $rootRunId: 'wrun_root',
      $parentRunId: 'wrun_parent',
      tenant: 't1',
    };
    expect(seededAttributes()).toEqual(expected);
    // Lineage must also ride the resilient-start queue input, not just the
    // run_created event, so both creation paths carry it.
    expect(queue.mock.calls[0]?.[1]?.runInput?.attributes).toEqual(expected);
  });

  it('records no lineage when the run predates attribute support', async () => {
    await insideRun('wrun_parent', () =>
      start(wf('child-workflow'), [], {
        specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES - 1,
      })
    );

    expect(seededAttributes()).toBeUndefined();
    expect(runsGet).not.toHaveBeenCalled();
  });
});
