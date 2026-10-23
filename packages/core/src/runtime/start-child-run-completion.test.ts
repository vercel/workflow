import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextStorage } from '../step/context-storage.js';
import {
  CHILD_RUN_COMPLETION_CONTEXT_KEY,
  CHILD_RUN_COMPLETION_VERSION,
} from './child-run-completion.js';
import { Run } from './run.js';
import { start } from './start.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name, fn) => fn(undefined)),
  getActiveSpan: vi.fn().mockResolvedValue(undefined),
}));

/**
 * `start()` from inside a workflow stamps the child so it resumes its
 * parent's completion hook when it finishes, and hands back a `Run` that
 * remembers the parent, so the parent's `returnValue` can suspend on that hook
 * instead of polling. It must never stamp a child whose executing deployment
 * would not resume the hook: that parent would wait forever.
 */
describe('start() child-run completion stamping', () => {
  const workflow = Object.assign(() => Promise.resolve('ok'), {
    workflowId: 'child-workflow',
  });

  let eventsCreate: ReturnType<typeof vi.fn>;
  let queue: ReturnType<typeof vi.fn>;

  function useWorld(probeResponse?: Record<string, unknown>) {
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn().mockResolvedValue('dpl_caller'),
      events: { create: eventsCreate },
      queue,
      ...(probeResponse
        ? {
            streams: {
              get: vi.fn(
                async () =>
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode(
                          JSON.stringify({
                            healthy: true,
                            workflowCoreVersion: '0.0.0-test',
                            ...probeResponse,
                          })
                        )
                      );
                      controller.close();
                    },
                  })
              ),
            },
          }
        : {}),
    } as any);
  }

  beforeEach(() => {
    eventsCreate = vi
      .fn()
      .mockImplementation((runId) =>
        Promise.resolve({ run: { runId, status: 'pending' } })
      );
    queue = vi.fn().mockResolvedValue(undefined);
    useWorld();
  });

  afterEach(() => {
    setWorld(undefined);
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  function insideRun<T>(parentRunId: string, fn: () => Promise<T>) {
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
        ops: [],
      } as any,
      fn
    );
  }

  const stampedContext = () =>
    eventsCreate.mock.calls[0]?.[1]?.eventData?.executionContext;
  const queuedContext = () =>
    queue.mock.calls.find((c) => !String(c[0]).endsWith('health_check'))?.[1]
      ?.runInput?.executionContext;
  const serialized = (run: Run<unknown>) =>
    (Run as any)[WORKFLOW_SERIALIZE](run);

  it('does not stamp a top-level start()', async () => {
    const run = await start(workflow, []);

    expect(stampedContext()).not.toHaveProperty(
      CHILD_RUN_COMPLETION_CONTEXT_KEY
    );
    expect(serialized(run)).not.toHaveProperty('parentRunId');
  });

  it('stamps a same-deployment child and records the parent on its Run', async () => {
    const run = await insideRun('wrun_parent', () => start(workflow, []));

    expect(stampedContext()).toMatchObject({
      [CHILD_RUN_COMPLETION_CONTEXT_KEY]: true,
    });
    // The resilient-start path re-creates the run from the queue message.
    expect(queuedContext()).toMatchObject({
      [CHILD_RUN_COMPLETION_CONTEXT_KEY]: true,
    });
    expect(serialized(run)).toMatchObject({
      runId: run.runId,
      parentRunId: 'wrun_parent',
    });
  });

  it('round-trips the parent through Run serialization', async () => {
    const run = await insideRun('wrun_parent', () => start(workflow, []));
    const revived = (Run as any)[WORKFLOW_DESERIALIZE](serialized(run));
    expect(serialized(revived)).toEqual(serialized(run));
  });

  it('honors the WORKFLOW_CHILD_RUN_COMPLETION_HOOK=0 kill switch', async () => {
    vi.stubEnv('WORKFLOW_CHILD_RUN_COMPLETION_HOOK', '0');
    const run = await insideRun('wrun_parent', () => start(workflow, []));

    expect(stampedContext()).not.toHaveProperty(
      CHILD_RUN_COMPLETION_CONTEXT_KEY
    );
    expect(serialized(run)).not.toHaveProperty('parentRunId');
  });

  it('stamps a cross-deployment child whose target advertises the hook', async () => {
    useWorld({ childRunCompletionVersion: CHILD_RUN_COMPLETION_VERSION });
    const run = await insideRun('wrun_parent', () =>
      start(workflow, [], { deploymentId: 'dpl_target' })
    );

    expect(stampedContext()).toMatchObject({
      [CHILD_RUN_COMPLETION_CONTEXT_KEY]: true,
    });
    expect(serialized(run)).toMatchObject({ parentRunId: 'wrun_parent' });
  });

  it('does not stamp a cross-deployment child whose target predates the hook', async () => {
    useWorld({});
    const run = await insideRun('wrun_parent', () =>
      start(workflow, [], { deploymentId: 'dpl_target' })
    );

    expect(stampedContext()).not.toHaveProperty(
      CHILD_RUN_COMPLETION_CONTEXT_KEY
    );
    expect(serialized(run)).not.toHaveProperty('parentRunId');
  });

  it('does not stamp a cross-deployment child it cannot probe', async () => {
    const run = await insideRun('wrun_parent', () =>
      start(workflow, [], { deploymentId: 'dpl_target' })
    );

    expect(stampedContext()).not.toHaveProperty(
      CHILD_RUN_COMPLETION_CONTEXT_KEY
    );
    expect(serialized(run)).not.toHaveProperty('parentRunId');
  });
});
