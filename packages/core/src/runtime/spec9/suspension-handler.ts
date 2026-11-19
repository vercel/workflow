import type { Span } from '@opentelemetry/api';
import {
  EntityConflictError,
  FatalError,
  RunExpiredError,
} from '@workflow/errors';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type SerializedData,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type WorkflowRun,
  type World,
} from '@workflow/world';

import type {
  AttributeInvocationQueueItem,
  HookInvocationQueueItem,
  StepInvocationQueueItem,
  WaitInvocationQueueItem,
  WorkflowSuspension,
} from '../../global.js';
import { runtimeLogger } from '../../logger.js';

import * as Attribute from '../../telemetry/semantic-conventions.js';

import type { PendingQueueDrain } from '../../workflow.js';
import type { SuspensionSerializationBlocker } from '../delivery.js';
import {
  absorbSkippedSlotReport,
  type EventCreator,
  type LoadedEventLog,
  mergeReportedEvents,
  slotSnapshotParams,
} from '../helpers.js';
import { isWorldValidationFailure } from '../hook-creation.js';
import { republishOwedForceClaimVictimWakes } from '../hook-wake.js';
import { ReplayRecoveryReporter } from '../replay-recovery-reporter.js';
import { settlePhase, startSuspensionHookWrites } from '../suspension-hooks.js';

export interface SuspensionHandlerParams {
  suspension: WorkflowSuspension;
  world: World;
  run: WorkflowRun;
  span?: Span;
  requestId?: string;
  /**
   * The workflow is completing or failing. Its terminal event cleans up hooks,
   * so only dispose hooks needed to release a token early or for a later
   * registration.
   */
  terminalDrain?: boolean;
  /**
   * The runtime's loaded event log. Every event creation this suspension makes
   * names the position it was derived from, so a backend that has recorded
   * events the replay did not see can report them back on the write, or, if
   * it would rather refuse than report, reject it with a 412. A rejection is
   * not retried here: the event's correlation id was minted by *this* replay's
   * seeded sequence, so re-committing it against a corrected log would persist
   * an event no correct replay produces. The caller restarts the replay
   * instead.
   *
   * Extended in place by what those writes report back — the events on slots
   * they skipped over, and (on the hook create) the inline delta since its
   * cursor.
   */
  eventLog?: LoadedEventLog;
  /** One-shot telemetry reporter, activated only after replay has recovered. */
  replayRecoveryReporter?: ReplayRecoveryReporter;
  /**
   * The invocation's record of hooks whose force-claim victim wake it has
   * already published or attempted, whether as the forced creation's own wake
   * or as a replay's republish (see `republishOwedForceClaimVictimWakes`). The
   * caller passes one set for the whole invocation so a run that suspends more
   * than once per invocation sends each hook's wake once, not once per
   * suspension. Omitted, every suspension republishes on its own.
   */
  forceClaimVictimWakes?: Set<string>;
  /**
   * Writes this suspension's events in place of `world.events.create`. The
   * single-orchestrator runtime passes its in-band writer, so every write is
   * marked in-band and fenced.
   */
  writeEvent?: EventCreator;
}

/**
 * What a suspension's hook and attribute writes mean for the caller: the hook
 * awaiters they settled, the time spent committing hooks, and serialization
 * diagnostics. The live caller writes a suspension's steps and waits itself;
 * the end-of-run drain writes them here and reads nothing back.
 */
export interface SuspensionHandlerResult {
  /**
   * Correlation ids of the hooks this suspension committed a `hook_created`
   * for while a `hook.getConflict()` awaiter was waiting on it — the events
   * that resolve those awaiters on the next pass.
   *
   * Reported by id, not just counted, so a caller that continues in this
   * process can tell a continuation that got somewhere from one that is
   * repeating: a workflow may create one awaited hook after another, and each
   * new id is a pass that made progress, while the same id coming back means
   * the pass ran over a log that still did not hold its event and continuing
   * again cannot change that.
   */
  awaitedHookCorrelationIds: string[];
  /**
   * Correlation ids of the hooks whose create committed a `hook_conflict`:
   * the token was already claimed, so this run's hook was never created. The
   * caller answers it by advancing the workflow over the committed event
   * before it dispatches or runs the steps this suspension scheduled.
   *
   * By id for the same reason as {@link awaitedHookCorrelationIds}, and
   * against the same hazard: a conflict is resolved by the `hook_conflict`
   * this suspension committed, and until the workflow observes it the hook
   * stays in the invocations queue and the next pass writes the create again.
   * A fresh id is progress; the same id coming back is a pass that ran over a
   * log which still did not hold the event, so continuing again cannot change
   * that.
   */
  hookConflictCorrelationIds: string[];
  /**
   * Wall-clock ms this suspension spent blocked on nothing but committing its
   * `hook_created` events (0 when it created none): the stretch the hook
   * writes outlasted every other write, since until then the suspension was
   * waiting on those too. The caller accumulates this across iterations and
   * subtracts it from the TTFS latency measurement, so time spent durably
   * creating the user's hooks doesn't count as runtime overhead.
   */
  hookCreationMs: number;
  /** Exact number of workflow-code executions observed during serialization. */
  serializationBlockerCount: number;
  /** Bounded sample used only for retention diagnostics. */
  serializationBlockers: SuspensionSerializationBlocker[];
}

/**
 * Writes a suspension's pending hook, attribute, step and wait events. The
 * live spec 9 orchestrator passes only hooks and attributes (it writes steps
 * and waits itself, with their execution mode); the end-of-run drain passes
 * everything, and steps written here are never queued or run.
 *
 * Every write is issued concurrently: hook creations and disposals (in code
 * order per token, then abort deliveries), step and wait events (batched where
 * the World supports it), and attribute events.
 *
 * Hooks are not written ahead of the steps created alongside them. A step
 * started in the same suspension as a hook can therefore run before that hook
 * is registered; a workflow that needs the hook registered first (say, a step
 * that hands the token to something that resumes it at once) awaits
 * `hook.getConflict()` before calling the step.
 */
export async function handleSuspension({
  suspension,
  world,
  run,
  span,
  requestId,
  eventLog,
  replayRecoveryReporter,
  forceClaimVictimWakes,
  writeEvent,
  terminalDrain,
}: SuspensionHandlerParams): Promise<SuspensionHandlerResult> {
  const runId = run.runId;

  // Every recent forced creation in the loaded log may still owe its victim a
  // wake (the invocation that created it may have died before publishing), so
  // it is republished, as an unkeyed wake; see
  // `forcedCreationsOwingWake` for the rule and its window. The rule reads
  // nothing this suspension writes, so the republish goes out alongside the
  // writes below instead of ahead of them, and is joined before returning.
  // It never rejects.
  const owedVictimWakes = republishOwedForceClaimVictimWakes(
    world,
    runId,
    eventLog?.events,
    { alreadyWoken: forceClaimVictimWakes }
  );

  // Every suspension write carries replay-recovery telemetry on the first one
  // that commits after replay recovered. All suspension events are
  // non-run_created events on this run's `runId`.
  const reporter = replayRecoveryReporter ?? ReplayRecoveryReporter.inert();
  const createEvent = (data: CreateEventRequest, params?: CreateEventParams) =>
    reporter.withEventCreate(params, (p) =>
      writeEvent ? writeEvent(data, p) : world.events.create(runId, data, p)
    );
  // Adds the optimistic-concurrency guard when the caller supplied a loaded
  // event log; without one it creates directly (callers with no replay
  // snapshot, e.g. tests). A stale (412) rejection propagates to the caller,
  // which restarts the replay from a corrected log. It is not retried here,
  // because the event's correlation id was minted by *this* replay's seeded
  // sequence, so re-committing it against a corrected log would persist an
  // event no correct replay produces.
  const createGuarded: EventCreator = async (data, params) => {
    if (!eventLog) {
      return createEvent(data, params);
    }
    const log = eventLog;
    const result = await createEvent(data, {
      ...params,
      ...slotSnapshotParams(log.events),
    });
    // An inline delta this call asked for (`sinceCursor`) is everything the
    // log gained since that cursor, this write included, so it is folded onto
    // the tail and carries the cursor with it — unlike a skipped-slot report,
    // which is a window strictly below the write and has to be sorted back
    // into place. A World returns one or the other, never both (the delta is a
    // strict superset), so the two are handled apart rather than merged.
    //
    // Declining is always safe — an unabsorbed delta is one the next read
    // returns — so the guards match the replay loop's `absorbCreateDelta`: a
    // truncated page (`hasMore`) is dropped whole rather than advancing the
    // cursor past events it did not carry, and the log must still be at the
    // cursor the request was computed from.
    //
    // The delta is merged in slot order rather than appended: the hook create
    // that asks for it runs concurrently with this suspension's other writes,
    // and one of those may have folded a skipped-slot report in while it was
    // in flight, leaving events above some of the delta's. The union is still
    // a prefix of the log (the delta covers everything from the cursor up to
    // this write, a report everything its write skipped), so sorting it is
    // all the repair it needs.
    if (typeof params?.sinceCursor === 'string') {
      if (
        log.cursor === params.sinceCursor &&
        result.events !== undefined &&
        result.hasMore !== true
      ) {
        mergeReportedEvents(log.events, result.events);
        log.cursor = result.cursor ?? log.cursor;
      }
      return result;
    }
    // Bump-and-report: the write landed above the slot it asked for, so the
    // report holds the events it was decided without. Absorbing here rather
    // than at each call site means the rest of this phase's writes (which read
    // the same array to build their own snapshot) ask for a slot above them,
    // and the replay that resumes from this log sees them without a reload.
    const report = absorbSkippedSlotReport(log.events, result);
    if (report.truncated) {
      runtimeLogger.debug('Dropped a truncated skipped-slot report', {
        workflowRunId: runId,
        eventType: data.eventType,
        eventId: result.event?.eventId,
        offered: report.offered,
      });
    } else if (report.added > 0) {
      runtimeLogger.debug('Suspension write skipped occupied slots', {
        workflowRunId: runId,
        eventType: data.eventType,
        eventId: result.event?.eventId,
        reported: report.added,
      });
    }
    return result;
  };
  // Separate queue items by type
  const stepItems = suspension.items.filter(
    (item): item is StepInvocationQueueItem => item.type === 'step'
  );
  const allHookItems = suspension.items.filter(
    (item): item is HookInvocationQueueItem =>
      item.type === 'hook' &&
      !(
        terminalDrain &&
        item.isSystem &&
        !item.hasCreatedEvent &&
        !item.abortRequested
      )
  );
  const waitItems = suspension.items.filter(
    (item): item is WaitInvocationQueueItem => item.type === 'wait'
  );
  const attributeItems = suspension.items.filter(
    (item): item is AttributeInvocationQueueItem => item.type === 'attribute'
  );

  const hooksNeedingCreation = allHookItems.filter(
    (item) => !item.hasCreatedEvent
  );

  const hookWrites = await startSuspensionHookWrites({
    suspension,
    world,
    run,
    runId,
    requestId,
    allHookItems,
    hooksNeedingCreation,
    eventLog,
    forceClaimVictimWakes,
    createGuarded,
    eventSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    terminalDrain,
  });
  const {
    dehydrateInput,
    blockers,
    hookConflictCorrelationIds,
    awaitedHookCorrelationIds,
    hookOp,
  } = hookWrites;
  let hookCreationMs = 0;

  // Create step events for steps that don't have them yet.
  // Unlike V1, we do NOT queue step messages from here: the caller
  // decides which steps to execute inline vs. queue to background.
  // Wait events are also created in parallel below.
  const stepsNeedingCreation = new Set(
    stepItems
      .filter((queueItem) => !queueItem.hasCreatedEvent)
      .map((queueItem) => queueItem.correlationId)
  );

  const ops: Promise<void>[] = [];
  // Already in flight (see `hookOp`); settled with everything else below.
  if (hookOp) ops.push(hookOp);

  // Steps and waits. The single-orchestrator runtime writes the steps and
  // waits of a live suspension itself (with their execution mode); what
  // reaches here is the end-of-run drain, which records fire-and-forget
  // steps and waits as created so the log shows them. They are never
  // enqueued or run, so they are marked background-mode.
  for (const queueItem of stepItems) {
    if (!stepsNeedingCreation.has(queueItem.correlationId)) continue;
    ops.push(
      (async () => {
        let dehydratedInput: SerializedData;
        try {
          dehydratedInput = await dehydrateInput(
            {
              args: queueItem.args,
              closureVars: queueItem.closureVars,
              thisVal: queueItem.thisVal,
            },
            {
              source: 'step_input',
              correlationId: queueItem.correlationId,
            }
          );
        } catch (err) {
          // The drain has nothing to observe a finalization, so an input
          // that does not serialize leaves no rows (the drain's own catch
          // swallows the error).
          throw err;
        }
        try {
          await createGuarded(
            {
              eventType: 'step_created' as const,
              specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
              correlationId: queueItem.correlationId,
              eventData: {
                stepName: queueItem.stepName,
                workflowName: run.workflowName,
                input: dehydratedInput,
                inline: false,
              },
            },
            { requestId }
          );
        } catch (err) {
          if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
            runtimeLogger.info('Step not recorded by the drain, continuing', {
              workflowRunId: runId,
              correlationId: queueItem.correlationId,
              message: err.message,
            });
          } else {
            throw err;
          }
        }
      })()
    );
  }

  for (const queueItem of waitItems) {
    if (queueItem.hasCreatedEvent) continue;
    ops.push(
      (async () => {
        try {
          await createGuarded(
            {
              eventType: 'wait_created' as const,
              specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
              correlationId: queueItem.correlationId,
              eventData: { resumeAt: queueItem.resumeAt },
            },
            { requestId }
          );
        } catch (err) {
          if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
            runtimeLogger.info('Wait not recorded by the drain, continuing', {
              workflowRunId: runId,
              correlationId: queueItem.correlationId,
              message: err.message,
            });
          } else {
            throw err;
          }
        }
      })()
    );
  }

  for (const queueItem of attributeItems) {
    ops.push(
      (async () => {
        try {
          // Guarded like every other suspension write: an attr_set is a
          // replay-derived event with a correlation id from this replay's
          // seeded sequence, so it must not land on a log the replay never
          // saw. Rejecting it is cheap: a run with attribute events already
          // forces an in-process replay, so the restart costs the replay it
          // was going to do anyway.
          await createGuarded(
            {
              eventType: 'attr_set',
              specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
              correlationId: queueItem.correlationId,
              eventData: {
                changes: queueItem.changes,
                writer: { type: 'workflow' },
                ...(queueItem.allowReservedAttributes
                  ? { allowReservedAttributes: true }
                  : {}),
              },
            },
            { requestId }
          );
        } catch (err) {
          if (EntityConflictError.is(err)) {
            runtimeLogger.info(
              'Workflow attribute event already exists, continuing',
              {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              }
            );
          } else if (isWorldValidationFailure(err)) {
            // Deterministic validation rejection from the World, e.g. the
            // cumulative per-run attribute cap, which only the World can
            // check against the run's existing attributes. Redelivering the
            // orchestrator message replays the workflow into the exact same
            // write and the exact same rejection, so retrying can never
            // succeed. Surface it as a FatalError so the caller fails the
            // run with a clear error instead of wedging it in redelivery.
            const fatal = new FatalError(
              `setAttributes failed World validation: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
            fatal.cause = err;
            throw fatal;
          } else {
            throw err;
          }
        }
      })()
    );
  }

  // Await the step_created / wait_created event creates before returning.
  // The caller (workflowEntrypoint) only enqueues the step-dispatch queue
  // messages AFTER handleSuspension resolves, and the queue handler acks
  // the orchestrator message only after the caller resolves. So the step_created
  // events must be durable here, and the dispatch sends must complete in the caller,
  // all before ack. If the process crashes before this resolves, the orchestrator
  // message is not acked and VQS redelivers, re-creates the (idempotent)
  // step_created and re-dispatches, and recovers the run instead of orphaning it.
  const nonHookOpsSettled = Promise.allSettled(
    ops.filter((op) => op !== hookOp)
  ).then(() => Date.now());
  try {
    await settlePhase(ops);
  } finally {
    await owedVictimWakes;
  }

  // The hook writes' share of this suspension's wall time: only the stretch
  // they held it after every other write had settled, since until then the
  // suspension was waiting on those writes too.
  const hookGroupsWindow = hookWrites.hookGroupsWindow();
  if (hookGroupsWindow?.endMs !== undefined) {
    const blockedFromMs = Math.max(
      hookGroupsWindow.startMs,
      await nonHookOpsSettled
    );
    hookCreationMs += Math.max(0, hookGroupsWindow.endMs - blockedFromMs);
  }

  span?.setAttributes({
    ...Attribute.WorkflowRunStatus('workflow_suspended'),
    ...Attribute.WorkflowStepsCreated(stepItems.length),
    ...Attribute.WorkflowHooksCreated(hooksNeedingCreation.length),
    ...Attribute.WorkflowWaitsCreated(waitItems.length),
  });

  return {
    hookConflictCorrelationIds,
    awaitedHookCorrelationIds,
    hookCreationMs,
    serializationBlockerCount: blockers.count,
    serializationBlockers: blockers.sample,
  };
}

/**
 * The end-of-run drain of the spec 9 orchestrator (see `PendingQueueDrain`):
 * the queued items are written like any suspension's, through the
 * orchestrator's in-band writer.
 */
export function pendingQueueDrain(
  world: World,
  writeEvent: EventCreator
): PendingQueueDrain {
  return async (suspension, run) => {
    await handleSuspension({
      suspension,
      world,
      run,
      writeEvent,
      terminalDrain: true,
    });
  };
}
