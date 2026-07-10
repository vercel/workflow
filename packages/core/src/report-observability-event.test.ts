import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_reportObservabilityEvent } from './report-observability-event.js';
import { contextStorage, type StepContext } from './step/context-storage.js';

const waitUntilPromises: Promise<unknown>[] = [];

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  }),
}));

const WORLD_CACHE = Symbol.for('@workflow/world//cache');
const globals = globalThis as Record<symbol, unknown>;

async function flushWaitUntil(): Promise<void> {
  await vi.waitFor(() => expect(waitUntilPromises.length).toBeGreaterThan(0));
  await Promise.all(waitUntilPromises.splice(0));
}

function stepContext(runId = 'run_123'): StepContext {
  return {
    stepMetadata: {
      stepName: 'observabilityStep',
      stepId: 'step',
      stepStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      attempt: 2,
    },
    workflowMetadata: {
      workflowName: 'workflow',
      workflowRunId: runId,
      workflowStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      url: 'http://localhost/.well-known/workflow/v1/flow',
      features: { encryption: false },
    },
    ops: [],
  };
}

describe('experimental_reportObservabilityEvent', () => {
  let originalWorld: unknown;

  beforeEach(() => {
    originalWorld = globals[WORLD_CACHE];
    waitUntilPromises.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalWorld === undefined) {
      delete globals[WORLD_CACHE];
    } else {
      globals[WORLD_CACHE] = originalWorld;
    }
  });

  it('no-ops outside workflow context', async () => {
    expect(
      experimental_reportObservabilityEvent({
        type: 'action.result',
        data: { status: 'failed' },
      })
    ).toBeUndefined();
  });

  it('posts event through an observability-capable world', async () => {
    const reportEvent = vi.fn().mockResolvedValue({ ok: true });
    globals[WORLD_CACHE] = {
      specVersion: SPEC_VERSION_CURRENT,
      observability: { reportEvent },
    };

    await contextStorage.run(stepContext(), () =>
      experimental_reportObservabilityEvent({
        type: 'action.result',
        data: { status: 'failed' },
        meta: { at: '2026-01-01T00:00:00.000Z' },
      })
    );
    await flushWaitUntil();

    expect(reportEvent).toHaveBeenCalledWith('run_123', {
      event: {
        type: 'action.result',
        data: { status: 'failed' },
        meta: { at: '2026-01-01T00:00:00.000Z' },
      },
      writer: { type: 'step', stepId: 'step', attempt: 2 },
    });
  });

  it('no-ops when the world has no observability reporter', async () => {
    globals[WORLD_CACHE] = { specVersion: SPEC_VERSION_CURRENT };

    expect(
      contextStorage.run(stepContext(), () =>
        experimental_reportObservabilityEvent({
          type: 'action.result',
          data: { status: 'failed' },
        })
      )
    ).toBeUndefined();
    await flushWaitUntil();
  });
});
