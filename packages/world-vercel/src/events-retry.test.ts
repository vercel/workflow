import {
  EntityConflictError,
  HookNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration coverage for the retry seam in `createWorkflowRunEvent`: that
// `data.eventType` is actually threaded into `withEventPostRetry`, and that the
// existing 404 → HookNotFoundError mapping still fires *after* the retry loop.
// The unit tests in event-retry.test.ts cover the retry logic in isolation; a
// refactor that wrapped the wrong layer (or passed the wrong event type) would
// keep those green but break here. We mock the v4 wire client so we can assert
// attempt counts and error mapping without standing up a real transport.
const { createV4Mock } = vi.hoisted(() => ({ createV4Mock: vi.fn() }));

vi.mock('./events-v4.js', () => ({
  createWorkflowRunEventV4: createV4Mock,
  getEventV4: vi.fn(),
  getWorkflowRunEventsV4: vi.fn(),
  getEventsByCorrelationIdV4: vi.fn(),
}));

import { createWorkflowRunEvent } from './events.js';

const RUN_ID = 'wrun_test';
const CONFIG = { token: 'test-token' };

const stepCompleted = () => ({
  eventType: 'step_completed' as const,
  correlationId: 'step_1',
  specVersion: 2,
  eventData: {
    stepName: 's',
    workflowName: 'w',
    result: new Uint8Array(),
  },
});

const v4Success = () => ({
  eventId: 'evnt_1',
  runId: RUN_ID,
  createdAt: '2020-01-01T00:00:00.000Z',
  body: {
    event: {
      eventId: 'evnt_1',
      runId: RUN_ID,
      eventType: 'step_completed',
      correlationId: 'step_1',
      specVersion: 2,
      createdAt: '2020-01-01T00:00:00.000Z',
      eventData: { stepName: 's', workflowName: 'w' },
    },
  },
});

describe('createWorkflowRunEvent retry wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createV4Mock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient 5xx on step_completed and then succeeds', async () => {
    let calls = 0;
    createV4Mock.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new WorkflowWorldError('boom', { status: 503 });
      return v4Success();
    });

    const p = createWorkflowRunEvent(
      RUN_ID,
      stepCompleted(),
      undefined,
      CONFIG
    );
    await vi.runAllTimersAsync();

    const result = await p;
    expect(result.event).toBeDefined();
    expect(createV4Mock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a retry-time 409 as EntityConflictError', async () => {
    let calls = 0;
    createV4Mock.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new WorkflowWorldError('boom', { status: 503 });
      throw new EntityConflictError('already completed');
    });

    const p = createWorkflowRunEvent(
      RUN_ID,
      stepCompleted(),
      undefined,
      CONFIG
    ).catch((e) => e);
    await vi.runAllTimersAsync();

    const err = await p;
    expect(EntityConflictError.is(err)).toBe(true);
    expect(createV4Mock).toHaveBeenCalledTimes(2);
  });

  it('still maps a hook_disposed 404 to HookNotFoundError, after the retry loop, without retrying', async () => {
    createV4Mock.mockImplementation(async () => {
      throw new WorkflowWorldError('not found', { status: 404 });
    });

    await expect(
      createWorkflowRunEvent(
        RUN_ID,
        { eventType: 'hook_disposed', correlationId: 'hook_1', specVersion: 2 },
        undefined,
        CONFIG
      )
    ).rejects.toBeInstanceOf(HookNotFoundError);
    // 404 is definitive → one attempt; the mapping wraps the retry loop.
    expect(createV4Mock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an excluded event type (step_started) even on a 5xx', async () => {
    createV4Mock.mockImplementation(async () => {
      throw new WorkflowWorldError('boom', { status: 503 });
    });

    await expect(
      createWorkflowRunEvent(
        RUN_ID,
        { eventType: 'step_started', correlationId: 'step_1', specVersion: 2 },
        undefined,
        CONFIG
      )
    ).rejects.toBeInstanceOf(WorkflowWorldError);
    expect(createV4Mock).toHaveBeenCalledTimes(1);
  });
});
