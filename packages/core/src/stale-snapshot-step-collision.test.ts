import { EntityConflictError, ReplayDivergenceError } from '@workflow/errors';
import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowSuspension } from './global.js';
import { handleSuspension } from './runtime/suspension-handler.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from './serialization.js';
import { runWorkflow } from './workflow.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

describe('stale replay snapshots', () => {
  it('can assign the same deterministic step ID to different branch continuations', async () => {
    const runId = 'wrun_stale_snapshot_step_collision';
    const startedAt = new Date('2026-06-08T00:00:00.000Z');
    const workflowRun: WorkflowRun = {
      runId,
      workflowName: 'copilotWorkflow',
      status: 'running',
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt,
      deploymentId: 'test-deployment',
    };

    // This is the minimal source topology inferred from the customer logs.
    // The names mirror one observed divergence; the customer's encrypted
    // inputs prevent reconstructing its literal source and arguments.
    const workflowCode = `
      const doStreamStep =
        globalThis[Symbol.for("WORKFLOW_USE_STEP")](
          "step//@workflow/ai@4.1.2//doStreamStep"
        );
      const pollGenerationResultStep =
        globalThis[Symbol.for("WORKFLOW_USE_STEP")](
          "step//./workflows/copilot/steps/poll-generation-result//pollGenerationResultStep"
        );
      const closeStream =
        globalThis[Symbol.for("WORKFLOW_USE_STEP")](
          "step//@workflow/ai/agent@4.1.2//closeStream"
        );
      const convertChunksToUIMessages =
        globalThis[Symbol.for("WORKFLOW_USE_STEP")](
          "step//@workflow/ai/agent@4.1.2//convertChunksToUIMessages"
        );

      async function copilotWorkflow() {
        const streamBranch = doStreamStep().then(() => closeStream());
        const pollingBranch = pollGenerationResultStep().then(
          () => convertChunksToUIMessages()
        );
        await Promise.all([streamBranch, pollingBranch]);
        return "done";
      }

      globalThis.__private_workflows = new Map();
      globalThis.__private_workflows.set(
        "copilotWorkflow",
        copilotWorkflow
      );
    `;

    async function suspend(events: Event[]): Promise<WorkflowSuspension> {
      let error: unknown;
      try {
        await runWorkflow(workflowCode, workflowRun, events, undefined);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(WorkflowSuspension);
      return error as WorkflowSuspension;
    }

    const initialSuspension = await suspend([]);
    const doStream = initialSuspension.steps.find(
      (step) => step.type === 'step' && step.stepName.endsWith('//doStreamStep')
    );
    const pollGeneration = initialSuspension.steps.find(
      (step) =>
        step.type === 'step' &&
        step.stepName.endsWith('//pollGenerationResultStep')
    );
    expect(doStream?.type).toBe('step');
    expect(pollGeneration?.type).toBe('step');
    if (doStream?.type !== 'step' || pollGeneration?.type !== 'step') {
      throw new Error('Could not find initial branch steps');
    }

    const streamResult = await dehydrateStepReturnValue(
      'stream-result',
      runId,
      undefined,
      []
    );
    const pollingResult = await dehydrateStepReturnValue(
      'polling-result',
      runId,
      undefined,
      []
    );

    const baseEvents: Event[] = [
      {
        eventId: 'evnt_run_created',
        runId,
        eventType: 'run_created',
        createdAt: new Date('2026-06-08T00:00:00.000Z'),
      },
      {
        eventId: 'evnt_run_started',
        runId,
        eventType: 'run_started',
        createdAt: new Date('2026-06-08T00:00:00.001Z'),
      },
      {
        eventId: 'evnt_stream_created',
        runId,
        eventType: 'step_created',
        correlationId: doStream.correlationId,
        eventData: { stepName: doStream.stepName },
        createdAt: new Date('2026-06-08T00:00:00.002Z'),
      },
      {
        eventId: 'evnt_poll_created',
        runId,
        eventType: 'step_created',
        correlationId: pollGeneration.correlationId,
        eventData: { stepName: pollGeneration.stepName },
        createdAt: new Date('2026-06-08T00:00:00.003Z'),
      },
      {
        eventId: 'evnt_stream_started',
        runId,
        eventType: 'step_started',
        correlationId: doStream.correlationId,
        eventData: { stepName: doStream.stepName },
        createdAt: new Date('2026-06-08T00:00:00.004Z'),
      },
      {
        eventId: 'evnt_poll_started',
        runId,
        eventType: 'step_started',
        correlationId: pollGeneration.correlationId,
        eventData: { stepName: pollGeneration.stepName },
        createdAt: new Date('2026-06-08T00:00:00.005Z'),
      },
    ];

    const streamCompleted: Event = {
      eventId: 'evnt_stream_completed',
      runId,
      eventType: 'step_completed',
      correlationId: doStream.correlationId,
      eventData: {
        stepName: doStream.stepName,
        result: streamResult,
      },
      createdAt: new Date('2026-06-08T00:00:00.007Z'),
    };
    const pollingCompleted: Event = {
      eventId: 'evnt_poll_completed',
      runId,
      eventType: 'step_completed',
      correlationId: pollGeneration.correlationId,
      eventData: {
        stepName: pollGeneration.stepName,
        result: pollingResult,
      },
      createdAt: new Date('2026-06-08T00:00:00.006Z'),
    };

    // Two concurrent flow invocations load different partial snapshots.
    // Each sees one branch complete and allocates the next ULID to that
    // branch's continuation.
    const streamSnapshot = await suspend([...baseEvents, streamCompleted]);
    const pollingSnapshot = await suspend([...baseEvents, pollingCompleted]);
    const closeStreamStep = streamSnapshot.steps.find(
      (step) => step.type === 'step' && step.stepName.endsWith('//closeStream')
    );
    const convertChunksStep = pollingSnapshot.steps.find(
      (step) =>
        step.type === 'step' &&
        step.stepName.endsWith('//convertChunksToUIMessages')
    );
    expect(closeStreamStep?.type).toBe('step');
    expect(convertChunksStep?.type).toBe('step');
    if (
      closeStreamStep?.type !== 'step' ||
      convertChunksStep?.type !== 'step'
    ) {
      throw new Error('Could not find branch continuation steps');
    }

    expect(closeStreamStep.stepName).not.toBe(convertChunksStep.stepName);
    expect(closeStreamStep.correlationId).toBe(convertChunksStep.correlationId);

    // Run both stale suspensions through the production suspension handler.
    // The mock world models workflow-server's first-writer-wins step entity:
    // the second create for the same correlation ID returns EntityConflictError,
    // which handleSuspension treats as a benign duplicate.
    const storedStepEvents = new Map<string, Event>();
    let eventSequence = 0;
    const world = {
      specVersion: SPEC_VERSION_CURRENT,
      getEncryptionKeyForRun: vi.fn(async () => undefined),
      events: {
        create: vi.fn(async (_runId: string, event: CreateEventRequest) => {
          if (event.eventType !== 'step_created' || !event.correlationId) {
            throw new Error(`Unexpected event type: ${event.eventType}`);
          }
          if (storedStepEvents.has(event.correlationId)) {
            throw new EntityConflictError(
              `Step ${event.correlationId} already exists`
            );
          }

          const storedEvent = {
            ...event,
            eventId: `evnt_created_${++eventSequence}`,
            runId,
            createdAt: new Date('2026-06-08T00:00:00.008Z'),
          } as Event;
          storedStepEvents.set(event.correlationId, storedEvent);
          return { event: storedEvent };
        }),
      },
    } as unknown as World;

    await handleSuspension({
      suspension: streamSnapshot,
      world,
      run: workflowRun,
    });
    await handleSuspension({
      suspension: pollingSnapshot,
      world,
      run: workflowRun,
    });

    expect(storedStepEvents.size).toBe(1);
    const durableContinuation = storedStepEvents.get(
      closeStreamStep.correlationId
    );
    expect(durableContinuation?.eventData).toEqual(
      expect.objectContaining({ stepName: closeStreamStep.stepName })
    );
    if (!durableContinuation) {
      throw new Error('The continuation step was not persisted');
    }

    // The complete durable history orders pollingCompleted before
    // streamCompleted, so canonical replay assigns the shared correlation ID
    // to convertChunks... and then encounters the stored closeStream event.
    const mixedHistory: Event[] = [
      ...baseEvents,
      pollingCompleted,
      streamCompleted,
      durableContinuation,
    ];

    await expect(
      runWorkflow(workflowCode, workflowRun, mixedHistory, undefined)
    ).rejects.toEqual(
      expect.objectContaining({
        name: ReplayDivergenceError.name,
        message: expect.stringContaining(
          `belongs to "${closeStreamStep.stepName}", but the current step consumer is "${convertChunksStep.stepName}"`
        ),
      })
    );
  });
});
