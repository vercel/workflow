import { CorruptedEventLogError } from '@workflow/errors';
import type { Event, WorkflowRun } from '@workflow/world';
import type { CryptoKey } from '../encryption.js';
import { type QueueItem, WorkflowSuspension } from '../global.js';
import { runWorkflow } from '../workflow.js';

type TerminalRunEventType = 'run_completed' | 'run_failed' | 'run_cancelled';

export interface ReplayPendingOperation {
  type: QueueItem['type'];
  correlationId: string;
  stepName?: string;
  token?: string;
  resumeAt?: Date;
  hasCreatedEvent?: boolean;
  disposed?: boolean;
  isWebhook?: boolean;
  isSystem?: boolean;
  abortRequested?: boolean;
}

export type ReplayWorkflowHistoryResult =
  | {
      status: 'completed';
      output: Uint8Array | unknown;
      terminalEvent?: Extract<Event, { eventType: 'run_completed' }>;
    }
  | {
      status: 'suspended';
      pendingOperations: ReplayPendingOperation[];
      counts: {
        steps: number;
        hooks: number;
        waits: number;
        hookDisposals: number;
        aborts: number;
      };
    }
  | {
      status: 'failed';
      error: unknown;
      terminalEvent?: Extract<Event, { eventType: 'run_failed' }>;
    }
  | {
      status: 'cancelled';
      terminalEvent: Extract<Event, { eventType: 'run_cancelled' }>;
    };

export interface ReplayWorkflowHistoryOptions {
  workflowCode: string;
  workflowRun: WorkflowRun;
  events: Event[];
  encryptionKey?: CryptoKey;
}

function isTerminalRunEvent(
  event: Event
): event is Extract<Event, { eventType: TerminalRunEventType }> {
  return (
    event.eventType === 'run_completed' ||
    event.eventType === 'run_failed' ||
    event.eventType === 'run_cancelled'
  );
}

function prepareReplayEvents(
  workflowRun: WorkflowRun,
  events: Event[]
): {
  replayEvents: Event[];
  terminalEvent?: Extract<Event, { eventType: TerminalRunEventType }>;
} {
  let terminalEvent:
    | Extract<Event, { eventType: TerminalRunEventType }>
    | undefined;
  const replayEvents: Event[] = [];

  for (const event of events) {
    if (event.runId !== workflowRun.runId) {
      throw new CorruptedEventLogError(
        `Replay history contains event "${event.eventId}" for run "${event.runId}", but expected run "${workflowRun.runId}"`
      );
    }

    if (terminalEvent) {
      throw new CorruptedEventLogError(
        `Replay history contains event "${event.eventId}" after terminal event "${terminalEvent.eventId}"`
      );
    }

    if (isTerminalRunEvent(event)) {
      terminalEvent = event;
    } else {
      replayEvents.push(event);
    }
  }

  return { replayEvents, terminalEvent };
}

function serializePendingOperation(item: QueueItem): ReplayPendingOperation {
  switch (item.type) {
    case 'step':
      return {
        type: item.type,
        correlationId: item.correlationId,
        stepName: item.stepName,
        hasCreatedEvent: item.hasCreatedEvent,
      };
    case 'hook':
      return {
        type: item.type,
        correlationId: item.correlationId,
        token: item.token,
        hasCreatedEvent: item.hasCreatedEvent,
        disposed: item.disposed,
        isWebhook: item.isWebhook,
        isSystem: item.isSystem,
        abortRequested: item.abortRequested,
      };
    case 'wait':
      return {
        type: item.type,
        correlationId: item.correlationId,
        resumeAt: item.resumeAt,
        hasCreatedEvent: item.hasCreatedEvent,
      };
  }
}

export async function replayWorkflowHistory({
  workflowCode,
  workflowRun,
  events,
  encryptionKey,
}: ReplayWorkflowHistoryOptions): Promise<ReplayWorkflowHistoryResult> {
  const { replayEvents, terminalEvent } = prepareReplayEvents(
    workflowRun,
    events
  );

  if (terminalEvent?.eventType === 'run_cancelled') {
    return {
      status: 'cancelled',
      terminalEvent,
    };
  }

  try {
    const output = await runWorkflow(
      workflowCode,
      workflowRun,
      replayEvents,
      encryptionKey,
      { drainPendingQueueItems: false }
    );

    if (terminalEvent?.eventType === 'run_failed') {
      throw new CorruptedEventLogError(
        `Replay history ended with "${terminalEvent.eventType}", but workflow replay completed`
      );
    }

    return {
      status: 'completed',
      output,
      terminalEvent:
        terminalEvent?.eventType === 'run_completed'
          ? terminalEvent
          : undefined,
    };
  } catch (error) {
    if (WorkflowSuspension.is(error)) {
      if (terminalEvent) {
        throw new CorruptedEventLogError(
          `Replay history ended with "${terminalEvent.eventType}", but workflow replay suspended`
        );
      }

      return {
        status: 'suspended',
        pendingOperations: error.steps.map(serializePendingOperation),
        counts: {
          steps: error.stepCount,
          hooks: error.hookCount,
          waits: error.waitCount,
          hookDisposals: error.hookDisposedCount,
          aborts: error.abortCount,
        },
      };
    }

    if (terminalEvent?.eventType === 'run_failed') {
      return {
        status: 'failed',
        error,
        terminalEvent,
      };
    }

    throw error;
  }
}
