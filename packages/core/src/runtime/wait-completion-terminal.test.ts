import {
  EntityConflictError,
  RunExpiredError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type CreateEventRequest,
  type Event,
  type EventResult,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

const runId = 'wrun_terminal_wait';
const workflowName = 'workflow';
const deploymentId = 'dpl_terminal_wait';
const waitCorrelationId = 'wait_terminal';
const startedAt = new Date('2026-05-19T12:00:00.000Z');
const fixedNow = new Date('2026-05-19T13:00:00.000Z');

/**
 * The wait's continuation message arriving at a run that already finished.
 *
 * `run_started` is the runtime's first write on every delivery, and how a
 * terminal run is discovered: a World that reaps the run rejects it
 * (`runStartedOutcome: 'expired'` / `'conflict'`), one that keeps it answers
 * with the terminal row (`'terminal-run'`), and one that accepts the write
 * leaves the terminal event to be found in the log
 * (`'terminal-in-log'` — the node replay loop's own check).
 *
 * All four have the same job: record the due wait's `wait_completed`, do no
 * replay, and acknowledge.
 */
async function runTerminalDeliveryScenario(options: {
  runStartedOutcome:
    | 'expired'
    | 'conflict'
    | 'terminal-run'
    | 'terminal-in-log';
  /** `resumeAt` of the run's single open wait. Defaults to already elapsed. */
  waitResumeAt?: Date;
  /** Rejection for the `wait_completed` write, if any. */
  rejectWaitCompletion?: () => unknown;
}) {
  vi.spyOn(Date, 'now').mockReturnValue(+fixedNow);

  const workflowArgs = await dehydrateWorkflowArguments([], runId, undefined);
  const terminalRunStatus =
    options.runStartedOutcome === 'terminal-run' ? 'completed' : 'running';
  const workflowRun = {
    runId,
    workflowName,
    status: terminalRunStatus,
    input: workflowArgs,
    deploymentId,
    specVersion: SPEC_VERSION_CURRENT,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
    ...(terminalRunStatus === 'completed' ? { completedAt: startedAt } : {}),
  } as WorkflowRun;

  let eventIndex = 0;
  const event = (data: CreateEventRequest): Event => {
    eventIndex += 1;
    return {
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: slotToEventId(eventIndex),
      createdAt: new Date(+startedAt + eventIndex * 100),
    } as Event;
  };

  const durableEvents: Event[] = [
    event({
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { deploymentId, workflowName, input: workflowArgs },
    } as unknown as CreateEventRequest),
    event({ eventType: 'run_started', specVersion: SPEC_VERSION_CURRENT }),
    event({
      eventType: 'wait_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: waitCorrelationId,
      eventData: {
        resumeAt: options.waitResumeAt ?? new Date(+fixedNow - 1_000),
      },
    }),
    event({
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { output: undefined },
    } as unknown as CreateEventRequest),
  ];

  const createdEvents: Event[] = [];
  const listEvents = vi.fn(async () => ({
    data: [...durableEvents],
    hasMore: false,
    cursor: durableEvents.at(-1)?.eventId ?? null,
  }));

  const createEvent = vi.fn(
    async (_runId: string, request: CreateEventRequest) => {
      if (request.eventType === 'run_started') {
        switch (options.runStartedOutcome) {
          case 'expired':
            throw new RunExpiredError(
              `Workflow run "${runId}" is already in terminal state "completed"`
            );
          case 'conflict':
            throw new EntityConflictError(
              `Cannot transition run from terminal state "completed"`
            );
          case 'terminal-run':
          case 'terminal-in-log':
            return {
              run: workflowRun,
              events: [...durableEvents],
              cursor: durableEvents.at(-1)?.eventId ?? null,
              hasMore: false,
              maxEvents: 10_000,
            } satisfies EventResult;
        }
      }
      if (
        request.eventType === 'wait_completed' &&
        options.rejectWaitCompletion
      ) {
        const err = options.rejectWaitCompletion();
        if (err) throw err;
      }
      const created = event(request);
      durableEvents.push(created);
      createdEvents.push(created);
      return { event: created };
    }
  );

  const queue = vi.fn().mockResolvedValue({ messageId: 'msg_out' });
  let capturedHandler:
    | ((
        message: unknown,
        metadata: { queueName: string; messageId: string; attempt: number }
      ) => Promise<unknown>)
    | undefined;

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn((_prefix, handler) => {
      capturedHandler = handler;
      return vi.fn();
    }),
    events: { list: listEvents, create: createEvent },
    queue,
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  const workflowCode = `
    const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
    async function workflow() {
      await sleep("1h");
    }
    ;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, workflow]]);
  `;

  const handler = workflowEntrypoint(workflowCode);
  await handler(new Request('http://localhost', { method: 'POST' }));
  expect(capturedHandler).toBeDefined();

  const deliver = () =>
    capturedHandler?.(
      { runId },
      {
        queueName: `__wkf_workflow_${workflowName}`,
        messageId: 'msg_wait_continuation',
        attempt: 1,
      }
    );

  return { deliver, createdEvents, createEvent, listEvents, queue };
}

describe('due wait completion on a terminal run', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
  });

  it.each([
    ['run_started is rejected as expired', 'expired'],
    ['run_started conflicts with the terminal transition', 'conflict'],
    ['run_started reports the terminal run', 'terminal-run'],
    ['the terminal event is found in the event log', 'terminal-in-log'],
  ] as const)('records the due wait_completed when %s', async (_label, outcome) => {
    const scenario = await runTerminalDeliveryScenario({
      runStartedOutcome: outcome,
    });

    await expect(scenario.deliver()).resolves.toBeUndefined();

    expect(scenario.createdEvents).toEqual([
      expect.objectContaining({
        eventType: 'wait_completed',
        correlationId: waitCorrelationId,
      }),
    ]);
    // Terminal: no replay-derived writes and no follow-up message. The
    // acknowledgement above is the delivery's only other effect.
    expect(scenario.queue).not.toHaveBeenCalled();
  });

  it('leaves a wait that is not due yet alone', async () => {
    const scenario = await runTerminalDeliveryScenario({
      runStartedOutcome: 'expired',
      waitResumeAt: new Date(+fixedNow + 60_000),
    });

    await scenario.deliver();

    expect(scenario.createdEvents).toEqual([]);
  });

  it('does not complete a wait twice across redeliveries', async () => {
    const scenario = await runTerminalDeliveryScenario({
      runStartedOutcome: 'expired',
    });

    await scenario.deliver();
    await scenario.deliver();

    expect(
      scenario.createdEvents.filter((e) => e.eventType === 'wait_completed')
    ).toHaveLength(1);
  });

  it('acknowledges when the World refuses to record the completion', async () => {
    // An older backend that drops a terminal run's waits has nowhere to put
    // the completion, and every redelivery would reach the same verdict.
    const scenario = await runTerminalDeliveryScenario({
      runStartedOutcome: 'expired',
      rejectWaitCompletion: () =>
        new WorkflowWorldError(`Wait "${waitCorrelationId}" not found`),
    });

    await expect(scenario.deliver()).resolves.toBeUndefined();
    expect(scenario.createdEvents).toEqual([]);
  });

  it('does not acknowledge when the completion fails transiently', async () => {
    const scenario = await runTerminalDeliveryScenario({
      runStartedOutcome: 'expired',
      rejectWaitCompletion: () =>
        new WorkflowWorldError('backend unavailable', { status: 503 }),
    });

    // Nack, so the next delivery retries the completion. The failure is the
    // World's, not the run's — nothing about the run is rewritten.
    await expect(scenario.deliver()).rejects.toThrow('backend unavailable');
    expect(scenario.createdEvents).toEqual([]);
  });
});
