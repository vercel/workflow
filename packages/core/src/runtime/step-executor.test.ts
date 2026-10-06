import { EntityConflictError, RetryableError } from '@workflow/errors';
import type { CreateEventRequest, Event, World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { dehydrateStepArguments } from '../serialization.js';
import {
  executeStep,
  failStepForExhaustedRetries,
  type StepEventWriter,
} from './step-executor.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const RUN = 'wrun_executor';

registerStepFunction('exec_ok', async (n: number) => n * 2);
registerStepFunction('exec_retry', async () => {
  throw new RetryableError('later', {
    retryAfter: new Date(Date.now() + 60_000),
  });
});

function recordingWriter(failOn?: string) {
  const written: CreateEventRequest[] = [];
  const createEvent: StepEventWriter = async (data) => {
    if (data.eventType === failOn) {
      throw new EntityConflictError('refused');
    }
    written.push(data);
    return {
      event: {
        ...data,
        runId: RUN,
        eventId: `evnt_${written.length}`,
        createdAt: new Date(),
      } as Event,
    };
  };
  return { written, createEvent };
}

const world = {
  getEncryptionKeyForRun: async () => undefined,
} as unknown as World;

async function input(args: unknown[]) {
  return (await dehydrateStepArguments({ args }, RUN, undefined)) as Uint8Array;
}

const base = {
  world,
  workflowRunId: RUN,
  workflowName: 'workflow',
  workflowStartedAt: Date.now(),
  stepId: 'step_a',
};

describe('executeStep', () => {
  it('writes stepName, attempt and startReason on step_started and the outcome', async () => {
    const { written, createEvent } = recordingWriter();
    const result = await executeStep({
      ...base,
      createEvent,
      stepName: 'exec_ok',
      attempt: 2,
      startReason: 'redelivery',
      input: await input([21]),
    });
    expect(result.type).toBe('completed');
    expect(written.map((e) => e.eventType)).toEqual([
      'step_started',
      'step_completed',
    ]);
    expect(written[0]).toMatchObject({
      eventData: { stepName: 'exec_ok', attempt: 2, startReason: 'redelivery' },
    });
    expect(written[1]).toMatchObject({ eventData: { stepName: 'exec_ok' } });
  });

  it('writes no start of its own when the caller already started the attempt', async () => {
    const { written, createEvent } = recordingWriter();
    await executeStep({
      ...base,
      createEvent,
      stepName: 'exec_ok',
      attempt: 1,
      startReason: 'first',
      input: await input([1]),
      started: { startedAt: new Date() },
    });
    expect(written.map((e) => e.eventType)).toEqual(['step_completed']);
  });

  it('writes step_retrying with the attempt and retryAfter, and asks for the delay', async () => {
    const { written, createEvent } = recordingWriter();
    const result = await executeStep({
      ...base,
      createEvent,
      stepName: 'exec_retry',
      attempt: 1,
      startReason: 'first',
      input: await input([]),
    });
    expect(result.type).toBe('retry');
    expect(written[1]).toMatchObject({
      eventType: 'step_retrying',
      eventData: {
        stepName: 'exec_retry',
        attempt: 1,
        retryAfter: expect.any(Date),
      },
    });
    if (result.type === 'retry') {
      expect(result.timeoutSeconds).toBeGreaterThan(50);
    }
  });

  it('fails the step instead of retrying past its message retention', async () => {
    const { written, createEvent } = recordingWriter();
    const result = await executeStep({
      ...base,
      createEvent,
      stepName: 'exec_retry',
      attempt: 1,
      startReason: 'first',
      input: await input([]),
      retryOutlivesMessage: () => true,
    });
    expect(result.type).toBe('failed');
    expect(written.map((e) => e.eventType)).toEqual([
      'step_started',
      'step_failed',
    ]);
    expect(written[1]).toMatchObject({ eventData: { attempt: 1 } });
  });

  it('never reads a refusal as "someone else ran it"', async () => {
    const { createEvent } = recordingWriter('step_started');
    await expect(
      executeStep({
        ...base,
        createEvent,
        stepName: 'exec_ok',
        attempt: 1,
        startReason: 'first',
        input: await input([1]),
      })
    ).rejects.toThrow(EntityConflictError);
  });

  it('does not run the body when beforeBody throws', async () => {
    const { written, createEvent } = recordingWriter();
    const body = vi.fn();
    registerStepFunction('exec_guarded', body);
    await expect(
      executeStep({
        ...base,
        createEvent,
        stepName: 'exec_guarded',
        attempt: 1,
        startReason: 'first',
        input: await input([]),
        beforeBody: () => {
          throw new Error('superseded');
        },
      })
    ).rejects.toThrow('superseded');
    expect(body).not.toHaveBeenCalled();
    expect(written.map((e) => e.eventType)).toEqual(['step_started']);
  });

  it('fails a step for exhausted retries without running it', async () => {
    const { written, createEvent } = recordingWriter();
    const result = await failStepForExhaustedRetries({
      createEvent,
      workflowRunId: RUN,
      stepId: 'step_a',
      stepName: 'exec_ok',
      attempt: 2,
      maxRetries: 0,
      encryptionKey: undefined,
    });
    expect(result.type).toBe('failed');
    expect(written).toEqual([
      expect.objectContaining({
        eventType: 'step_failed',
        eventData: expect.objectContaining({ attempt: 2 }),
      }),
    ]);
  });
});
