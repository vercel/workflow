import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  Event,
  EventResult,
  GetEventParams,
  Hook,
  ListEventsParams,
  ListHooksParams,
  PaginatedResponse,
  ResolveData,
  Step,
  StepWithoutData,
  Storage,
  StructuredError,
  Wait,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  EventSchema,
  HookSchema,
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
  stripEventDataRefs,
  validateUlidTimestamp,
  WorkflowRunSchema,
} from '@workflow/world';
import { and, asc, desc, eq, gt, lt, notInArray, sql } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import { type Drizzle, Schema } from './drizzle/index.js';
import type { SerializedContent } from './drizzle/schema.js';
import { compact } from './util.js';

/**
 * Parse legacy errorJson (text column with JSON-stringified StructuredError).
 * Used for backwards compatibility when reading from deprecated error column.
 */
function parseErrorJson(errorJson: string | null): StructuredError | null {
  if (!errorJson) return null;
  try {
    const parsed = JSON.parse(errorJson);
    if (typeof parsed === 'object' && parsed.message !== undefined) {
      return {
        message: parsed.message,
        stack: parsed.stack,
        code: parsed.code,
      };
    }
    // Not a structured error object, treat as plain string
    return { message: String(parsed) };
  } catch {
    // Not JSON, treat as plain string error message
    return { message: errorJson };
  }
}

/**
 * Deserialize run data, handling legacy error fields.
 * The error field should already be deserialized from CBOR or fallback to errorJson.
 * This function only handles very old legacy fields (errorStack, errorCode).
 */
function deserializeRunError(run: any): WorkflowRun {
  const { errorStack, errorCode, ...rest } = run;

  // If no legacy fields, return as-is (error is already a StructuredError or undefined)
  if (!errorStack && !errorCode) {
    return rest as WorkflowRun;
  }

  // Very old legacy: separate errorStack/errorCode fields
  const existingError = rest.error as StructuredError | undefined;
  return {
    ...rest,
    error: {
      message: existingError?.message || '',
      stack: existingError?.stack || errorStack,
      code: existingError?.code || errorCode,
    },
  } as WorkflowRun;
}

/**
 * Deserialize step data, mapping DB columns to interface fields.
 * The error field should already be deserialized from CBOR or fallback to errorJson.
 */
function deserializeStepError(step: any): Step {
  const { startedAt, ...rest } = step;

  return {
    ...rest,
    startedAt,
  } as Step;
}

export function createRunsStorage(drizzle: Drizzle): Storage['runs'] {
  const { runs } = Schema;
  const get = drizzle
    .select()
    .from(runs)
    .where(eq(runs.runId, sql.placeholder('id')))
    .limit(1)
    .prepare('workflow_runs_get');

  return {
    get: (async (id, params) => {
      const [value] = await get.execute({ id });
      if (!value) {
        throw new WorkflowRunNotFoundError(id);
      }
      value.output ||= value.outputJson;
      value.input ||= value.inputJson;
      value.executionContext ||= value.executionContextJson;
      value.error ||= parseErrorJson(value.errorJson);
      const deserialized = deserializeRunError(compact(value));
      const parsed = WorkflowRunSchema.parse(deserialized);
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(parsed, resolveData);
    }) as Storage['runs']['get'],
    list: (async (params) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(runs)
        .where(
          and(
            map(fromCursor, (c) => lt(runs.runId, c)),
            map(params?.workflowName, (wf) => eq(runs.workflowName, wf)),
            map(params?.status, (wf) => eq(runs.status, wf))
          )
        )
        .orderBy(desc(runs.runId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.output ||= v.outputJson;
          v.input ||= v.inputJson;
          v.executionContext ||= v.executionContextJson;
          v.error ||= parseErrorJson(v.errorJson);
          const deserialized = deserializeRunError(compact(v));
          const parsed = WorkflowRunSchema.parse(deserialized);
          return filterRunData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    }) as Storage['runs']['list'],
  };
}

function map<T, R>(obj: T | null | undefined, fn: (v: T) => R): undefined | R {
  return obj ? fn(obj) : undefined;
}

/**
 * Handle events for legacy runs (pre-event-sourcing, specVersion < 2).
 * Legacy runs use different behavior:
 * - run_cancelled: Skip event storage, directly update run
 * - wait_completed: Store event only (no entity mutation)
 * - hook_received: Store event only (hooks exist via old system, no entity mutation)
 * - Other events: Throw error (not supported for legacy runs)
 */
async function handleLegacyEventPostgres(
  drizzle: Drizzle,
  runId: string,
  eventId: string,
  data: any,
  currentRun: { status: string; specVersion: number | null },
  params?: { resolveData?: ResolveData }
): Promise<EventResult> {
  const resolveData = params?.resolveData ?? 'all';

  switch (data.eventType) {
    case 'run_cancelled': {
      // Legacy: Skip event storage, directly update run to cancelled
      const now = new Date();

      // Update run status to cancelled
      await drizzle
        .update(Schema.runs)
        .set({
          status: 'cancelled',
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(Schema.runs.runId, runId));

      // Delete all hooks and waits for this run
      await Promise.all([
        drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, runId)),
        drizzle.delete(Schema.waits).where(eq(Schema.waits.runId, runId)),
      ]);

      // Fetch updated run for return value
      const [updatedRun] = await drizzle
        .select()
        .from(Schema.runs)
        .where(eq(Schema.runs.runId, runId))
        .limit(1);

      // Return without event (legacy behavior skips event storage)
      // Type assertion: EventResult expects WorkflowRun, filterRunData may return WorkflowRunWithoutData
      return {
        run: updatedRun
          ? (filterRunData(
              deserializeRunError(compact(updatedRun)),
              resolveData
            ) as WorkflowRun)
          : undefined,
      };
    }

    case 'wait_completed':
    case 'hook_received': {
      // Legacy: Store event only (no entity mutation)
      // - wait_completed: for replay purposes
      // - hook_received: hooks exist via old system, just record the event
      const [insertedEvent] = await drizzle
        .insert(Schema.events)
        .values({
          runId,
          eventId,
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: 'eventData' in data ? data.eventData : undefined,
          specVersion: SPEC_VERSION_CURRENT,
        })
        .returning({ createdAt: Schema.events.createdAt });

      const event = EventSchema.parse({
        ...data,
        ...insertedEvent,
        runId,
        eventId,
      });
      return { event: stripEventDataRefs(event, resolveData) };
    }

    default:
      throw new Error(
        `Event type '${data.eventType}' not supported for legacy runs ` +
          `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
          `Please upgrade @workflow packages.`
      );
  }
}

export function createEventsStorage(drizzle: Drizzle): Storage['events'] {
  const ulid = monotonicFactory();
  const { events } = Schema;

  // Prepared statements for validation queries (performance optimization)
  const getRunForValidation = drizzle
    .select({
      status: Schema.runs.status,
      specVersion: Schema.runs.specVersion,
    })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, sql.placeholder('runId')))
    .limit(1)
    .prepare('events_get_run_for_validation');

  const getStepForValidation = drizzle
    .select({
      status: Schema.steps.status,
      startedAt: Schema.steps.startedAt,
      retryAfter: Schema.steps.retryAfter,
    })
    .from(Schema.steps)
    .where(
      and(
        eq(Schema.steps.runId, sql.placeholder('runId')),
        eq(Schema.steps.stepId, sql.placeholder('stepId'))
      )
    )
    .limit(1)
    .prepare('events_get_step_for_validation');

  const getHookByToken = drizzle
    .select({ hookId: Schema.hooks.hookId })
    .from(Schema.hooks)
    .where(eq(Schema.hooks.token, sql.placeholder('token')))
    .limit(1)
    .prepare('events_get_hook_by_token');

  const getWaitForValidation = drizzle
    .select({
      status: Schema.waits.status,
    })
    .from(Schema.waits)
    .where(eq(Schema.waits.waitId, sql.placeholder('waitId')))
    .limit(1)
    .prepare('events_get_wait_for_validation');

  return {
    async create(runId, data, params): Promise<EventResult> {
      const eventId = `wevt_${ulid()}`;

      // For run_created events, use client-provided runId or generate one server-side
      let effectiveRunId: string;
      if (data.eventType === 'run_created' && (!runId || runId === '')) {
        effectiveRunId = `wrun_${ulid()}`;
      } else if (!runId) {
        throw new Error('runId is required for non-run_created events');
      } else {
        effectiveRunId = runId;
      }

      // Validate client-provided runId timestamp is within acceptable threshold
      if (data.eventType === 'run_created' && runId && runId !== '') {
        const validationError = validateUlidTimestamp(effectiveRunId, 'wrun_');
        if (validationError) {
          throw new WorkflowWorldError(validationError);
        }
      }

      // specVersion is always sent by the runtime, but we provide a fallback for safety
      const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

      // Track entity created/updated for EventResult
      let run: WorkflowRun | undefined;
      let step: Step | undefined;
      let hook: Hook | undefined;
      let wait: Wait | undefined;
      const now = new Date();

      // Helper to check if run is in terminal state
      const isRunTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      // Helper to check if step is in terminal state
      const isStepTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      // Terminal step statuses for use in SQL WHERE clauses (atomic guard).
      // Must match the Vercel world's conditional expressions:
      //   ne(status, 'completed') AND ne(status, 'failed') AND ne(status, 'cancelled')
      const terminalStepStatuses: (typeof Schema.steps.status.enumValues)[number][] =
        ['completed', 'failed', 'cancelled'];

      // ============================================================
      // VALIDATION: Terminal state and event ordering checks
      // ============================================================

      // Get current run state for validation (if not creating a new run)
      // Skip run validation for step_completed and step_retrying - they only operate
      // on running steps, and running steps are always allowed to modify regardless
      // of run state. This optimization saves database queries per step event.
      let currentRun: { status: string; specVersion: number | null } | null =
        null;
      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (
        data.eventType !== 'run_created' &&
        !skipRunValidationEvents.includes(data.eventType)
      ) {
        // Use prepared statement for better performance
        const [runValue] = await getRunForValidation.execute({
          runId: effectiveRunId,
        });
        currentRun = runValue ?? null;

        // Resilient start: run_started on non-existent run with eventData
        // creates the run first, so the queue can bootstrap a run that
        // failed to create during start().
        if (
          data.eventType === 'run_started' &&
          !currentRun &&
          'eventData' in data &&
          data.eventData
        ) {
          const runInputData = (data as any).eventData as {
            deploymentId?: string;
            workflowName?: string;
            input?: any;
            executionContext?: Record<string, any>;
          };
          if (
            runInputData.deploymentId &&
            runInputData.workflowName &&
            runInputData.input !== undefined
          ) {
            // Create run + run_created event atomically. The
            // transaction ensures we never have an orphaned run
            // without its run_created event.
            const [inserted] = await drizzle
              .insert(Schema.runs)
              .values({
                runId: effectiveRunId,
                deploymentId: runInputData.deploymentId,
                workflowName: runInputData.workflowName,
                specVersion: effectiveSpecVersion,
                input: runInputData.input as SerializedContent,
                executionContext: runInputData.executionContext as
                  | SerializedContent
                  | undefined,
                status: 'pending',
              })
              .onConflictDoNothing()
              .returning();

            if (inserted) {
              const runCreatedEventId = `wevt_${ulid()}`;
              await drizzle.insert(events).values({
                runId: effectiveRunId,
                eventId: runCreatedEventId,
                eventType: 'run_created',
                eventData: {
                  deploymentId: runInputData.deploymentId,
                  workflowName: runInputData.workflowName,
                  input: runInputData.input,
                  executionContext: runInputData.executionContext,
                },
                specVersion: effectiveSpecVersion,
              });
            }
            const createdRun = inserted;

            if (createdRun) {
              currentRun = {
                status: 'pending',
                specVersion: effectiveSpecVersion,
              };
            } else {
              // Run already exists (concurrent run_created won the
              // race). Re-read so downstream logic sees the real state.
              const [runValue] = await getRunForValidation.execute({
                runId: effectiveRunId,
              });
              currentRun = runValue ?? null;
            }
          }
        }
      }

      // ============================================================
      // VERSION COMPATIBILITY: Check run spec version
      // ============================================================
      // For events that have fetched the run, check version compatibility.
      // Skip for run_created (no existing run) and runtime events (step_completed, step_retrying).
      if (currentRun) {
        // Check if run requires a newer world version
        if (requiresNewerWorld(currentRun.specVersion)) {
          throw new RunNotSupportedError(
            currentRun.specVersion!,
            SPEC_VERSION_CURRENT
          );
        }

        // Route to legacy handler for pre-event-sourcing runs
        if (isLegacySpecVersion(currentRun.specVersion)) {
          return handleLegacyEventPostgres(
            drizzle,
            effectiveRunId,
            eventId,
            data,
            currentRun,
            params
          );
        }
      }

      // Run terminal state validation
      if (currentRun && isRunTerminal(currentRun.status)) {
        const runTerminalEvents = [
          'run_started',
          'run_completed',
          'run_failed',
        ];

        // Idempotent operation: run_cancelled on already cancelled run is allowed
        if (
          data.eventType === 'run_cancelled' &&
          currentRun.status === 'cancelled'
        ) {
          // Get full run for return value
          const [fullRun] = await drizzle
            .select()
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1);

          // Create the event (still record it)
          const [value] = await drizzle
            .insert(Schema.events)
            .values({
              runId: effectiveRunId,
              eventId,
              correlationId: data.correlationId,
              eventType: data.eventType,
              eventData: 'eventData' in data ? data.eventData : undefined,
              specVersion: effectiveSpecVersion,
            })
            .returning({ createdAt: Schema.events.createdAt });

          const result = { ...data, ...value, runId: effectiveRunId, eventId };
          const parsed = EventSchema.parse(result);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: stripEventDataRefs(parsed, resolveData),
            run: fullRun ? deserializeRunError(compact(fullRun)) : undefined,
          };
        }

        // For run_started on terminal runs, use RunExpiredError so the
        // runtime knows to exit without retrying.
        if (data.eventType === 'run_started') {
          throw new RunExpiredError(
            `Workflow run "${effectiveRunId}" is already in terminal state "${currentRun.status}"`
          );
        }

        // Other run state transitions are not allowed on terminal runs
        if (
          runTerminalEvents.includes(data.eventType) ||
          data.eventType === 'run_cancelled'
        ) {
          throw new EntityConflictError(
            `Cannot transition run from terminal state "${currentRun.status}"`
          );
        }

        // Creating new entities on terminal runs is not allowed
        if (
          data.eventType === 'step_created' ||
          data.eventType === 'hook_created' ||
          data.eventType === 'wait_created'
        ) {
          throw new EntityConflictError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`
          );
        }
      }

      // Step-related event validation (ordering and terminal state)
      // Fetch status + startedAt so we can reuse for step_started (avoid double read)
      // Skip validation for step_completed/step_failed - use conditional UPDATE instead
      let validatedStep: {
        status: string;
        startedAt: Date | null;
        retryAfter: Date | null;
      } | null = null;
      const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
      if (
        stepEventsNeedingValidation.includes(data.eventType) &&
        data.correlationId
      ) {
        // Use prepared statement for better performance
        const [existingStep] = await getStepForValidation.execute({
          runId: effectiveRunId,
          stepId: data.correlationId,
        });

        validatedStep = existingStep ?? null;

        // Event ordering: step must exist before these events
        if (!validatedStep) {
          throw new WorkflowWorldError(
            `Step "${data.correlationId}" not found`
          );
        }

        // Step terminal state validation
        if (isStepTerminal(validatedStep.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`
          );
        }

        // On terminal runs: only allow completing/failing in-progress steps
        if (currentRun && isRunTerminal(currentRun.status)) {
          if (validatedStep.status !== 'running') {
            throw new RunExpiredError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`
            );
          }
        }
      }

      // Hook-related event validation (ordering)
      const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
      if (
        hookEventsRequiringExistence.includes(data.eventType) &&
        data.correlationId
      ) {
        const [existingHook] = await drizzle
          .select({ hookId: Schema.hooks.hookId })
          .from(Schema.hooks)
          .where(eq(Schema.hooks.hookId, data.correlationId))
          .limit(1);

        if (!existingHook) {
          throw new HookNotFoundError(data.correlationId);
        }
      }

      // ============================================================
      // Entity creation/updates based on event type
      // ============================================================

      // Handle run_created event: create the run entity atomically
      if (data.eventType === 'run_created') {
        const eventData = (data as any).eventData as {
          deploymentId: string;
          workflowName: string;
          input: any[];
          executionContext?: Record<string, any>;
        };
        const [runValue] = await drizzle
          .insert(Schema.runs)
          .values({
            runId: effectiveRunId,
            deploymentId: eventData.deploymentId,
            workflowName: eventData.workflowName,
            // Propagate specVersion from the event to the run entity
            specVersion: effectiveSpecVersion,
            input: eventData.input as SerializedContent,
            executionContext: eventData.executionContext as
              | SerializedContent
              | undefined,
            status: 'pending',
          })
          .onConflictDoNothing()
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        }
      }

      // Handle run_started event: update run status
      if (data.eventType === 'run_started') {
        // If the run is already running, return it without inserting a
        // duplicate run_started event.  This makes run_started idempotent
        // for concurrent invocations: replay is deterministic, so letting
        // multiple callers proceed with the same run is safe.  We skip
        // preloaded events here because this is a rare race-condition path
        // — the runtime falls back to getAllWorkflowRunEvents().
        if (currentRun?.status === 'running') {
          const [fullRun] = await drizzle
            .select()
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1);
          if (fullRun) {
            return { run: deserializeRunError(compact(fullRun)) };
          }
        }

        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'running',
            startedAt: now,
            updatedAt: now,
          })
          .where(eq(Schema.runs.runId, effectiveRunId))
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        }
      }

      // Terminal run statuses for use in SQL WHERE clauses (atomic guard).
      // Must match the Vercel world's conditional expressions:
      //   ne(status, 'completed') AND ne(status, 'failed') AND ne(status, 'cancelled')
      const terminalRunStatuses: (typeof Schema.runs.status.enumValues)[number][] =
        ['completed', 'failed', 'cancelled'];

      // Handle run_completed event: update run status and cleanup hooks
      // Uses conditional UPDATE to prevent completing an already-terminal run.
      if (data.eventType === 'run_completed') {
        const eventData = (data as any).eventData as { output?: any };
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'completed',
            output: eventData.output as SerializedContent | undefined,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, terminalRunStatuses)
            )
          )
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({
            runId: effectiveRunId,
          });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isRunTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`
            );
          }
        }
        // Delete all hooks and waits for this run to allow token reuse
        await Promise.all([
          drizzle
            .delete(Schema.hooks)
            .where(eq(Schema.hooks.runId, effectiveRunId)),
          drizzle
            .delete(Schema.waits)
            .where(eq(Schema.waits.runId, effectiveRunId)),
        ]);
      }

      // Handle run_failed event: update run status and cleanup hooks
      // Uses conditional UPDATE to prevent failing an already-terminal run.
      if (data.eventType === 'run_failed') {
        const eventData = (data as any).eventData as {
          error: any;
          errorCode?: string;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'failed',
            error: {
              message: errorMessage,
              stack: eventData.error?.stack,
              code: eventData.errorCode,
            },
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, terminalRunStatuses)
            )
          )
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({
            runId: effectiveRunId,
          });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isRunTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`
            );
          }
        }
        // Delete all hooks and waits for this run to allow token reuse
        await Promise.all([
          drizzle
            .delete(Schema.hooks)
            .where(eq(Schema.hooks.runId, effectiveRunId)),
          drizzle
            .delete(Schema.waits)
            .where(eq(Schema.waits.runId, effectiveRunId)),
        ]);
      }

      // Handle run_cancelled event: update run status and cleanup hooks
      // Uses conditional UPDATE to prevent cancelling an already-terminal run.
      // Note: idempotent run_cancelled on already-cancelled runs is handled
      // earlier in the pre-validation block (creates event and returns early).
      if (data.eventType === 'run_cancelled') {
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'cancelled',
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, terminalRunStatuses)
            )
          )
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({
            runId: effectiveRunId,
          });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isRunTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`
            );
          }
        }
        // Delete all hooks and waits for this run to allow token reuse
        await Promise.all([
          drizzle
            .delete(Schema.hooks)
            .where(eq(Schema.hooks.runId, effectiveRunId)),
          drizzle
            .delete(Schema.waits)
            .where(eq(Schema.waits.runId, effectiveRunId)),
        ]);
      }

      // Handle step_created event: create step entity
      if (data.eventType === 'step_created') {
        const eventData = (data as any).eventData as {
          stepName: string;
          input: any;
        };
        const [stepValue] = await drizzle
          .insert(Schema.steps)
          .values({
            runId: effectiveRunId,
            stepId: data.correlationId!,
            stepName: eventData.stepName,
            input: eventData.input as SerializedContent,
            status: 'pending',
            attempt: 0,
            // Propagate specVersion from the event to the step entity
            specVersion: effectiveSpecVersion,
          })
          .onConflictDoNothing()
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact(stepValue));
        }
      }

      // Handle step_started event: increment attempt, set status to 'running'
      // Sets startedAt (maps to startedAt) only on first start
      // Uses conditional UPDATE to prevent re-starting a step that has already
      // reached a terminal state (completed/failed). Without this guard a
      // concurrent step_started could revert a completed step back to 'running',
      // allowing a duplicate execution that corrupts the event log.
      if (data.eventType === 'step_started') {
        // Check if retryAfter timestamp hasn't been reached yet
        if (
          validatedStep?.retryAfter &&
          validatedStep.retryAfter.getTime() > Date.now()
        ) {
          throw new TooEarlyError(
            `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
            {
              retryAfter: Math.ceil(
                (validatedStep.retryAfter.getTime() - Date.now()) / 1000
              ),
            }
          );
        }

        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'running',
            // Increment attempt counter using SQL
            attempt: sql`${Schema.steps.attempt} + 1`,
            // Only set startedAt on first start — use COALESCE so concurrent
            // step_started calls can't clobber the original timestamp.
            startedAt: sql`COALESCE(${Schema.steps.startedAt}, ${now.toISOString()})`,
            // Always clear retryAfter now that the step has started
            retryAfter: null,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
              // Only update if not already in terminal state (prevents TOCTOU race)
              notInArray(Schema.steps.status, terminalStepStatuses)
            )
          )
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact(stepValue));
        } else {
          // Step not updated - check if it exists and why
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId!,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`
            );
          }
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`
            );
          }
        }
      }

      // Handle step_completed event: update step status
      // Uses conditional UPDATE to prevent completing an already-terminal step.
      if (data.eventType === 'step_completed') {
        const eventData = (data as any).eventData as { result?: any };
        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'completed',
            output: eventData.result as SerializedContent | undefined,
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
              notInArray(Schema.steps.status, terminalStepStatuses)
            )
          )
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact(stepValue));
        } else {
          // Step not updated - check if it exists and why
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId!,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`
            );
          }
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`
            );
          }
        }
      }

      // Handle step_failed event: terminal state with error
      // Uses conditional UPDATE to prevent failing an already-terminal step.
      if (data.eventType === 'step_failed') {
        const eventData = (data as any).eventData as {
          error?: any;
          stack?: string;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'failed',
            error: {
              message: errorMessage,
              stack: eventData.stack,
            },
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
              notInArray(Schema.steps.status, terminalStepStatuses)
            )
          )
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact(stepValue));
        } else {
          // Step not updated - check if it exists and why
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId!,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`
            );
          }
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`
            );
          }
        }
      }

      // Handle step_retrying event: sets status back to 'pending', records error
      // Uses conditional UPDATE to prevent retrying an already-terminal step.
      if (data.eventType === 'step_retrying') {
        const eventData = (data as any).eventData as {
          error?: any;
          stack?: string;
          retryAfter?: Date;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'pending',
            error: {
              message: errorMessage,
              stack: eventData.stack,
            },
            retryAfter: eventData.retryAfter,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
              notInArray(Schema.steps.status, terminalStepStatuses)
            )
          )
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact(stepValue));
        } else {
          // Step not updated - check if it exists and why
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId!,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`
            );
          }
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`
            );
          }
        }
      }

      // Handle hook_created event: create hook entity
      // Uses prepared statement for token uniqueness check (performance optimization)
      if (data.eventType === 'hook_created') {
        const eventData = (data as any).eventData as {
          token: string;
          metadata?: any;
          isWebhook?: boolean;
        };

        // Check for duplicate token using prepared statement
        const [existingHook] = await getHookByToken.execute({
          token: eventData.token,
        });
        if (existingHook) {
          // Create hook_conflict event instead of throwing 409
          // This allows the workflow to continue and fail gracefully when the hook is awaited
          const conflictEventData = {
            token: eventData.token,
          };

          const [conflictValue] = await drizzle
            .insert(events)
            .values({
              runId: effectiveRunId,
              eventId,
              correlationId: data.correlationId,
              eventType: 'hook_conflict',
              eventData: conflictEventData,
              specVersion: effectiveSpecVersion,
            })
            .returning({ createdAt: events.createdAt });

          if (!conflictValue) {
            throw new EntityConflictError(
              `Event ${eventId} could not be created`
            );
          }

          const conflictResult = {
            eventType: 'hook_conflict' as const,
            correlationId: data.correlationId,
            eventData: conflictEventData,
            ...conflictValue,
            runId: effectiveRunId,
            eventId,
          };
          const parsedConflict = EventSchema.parse(conflictResult);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: stripEventDataRefs(parsedConflict, resolveData),
            run,
            step,
            hook: undefined,
          };
        }

        const [hookValue] = await drizzle
          .insert(Schema.hooks)
          .values({
            runId: effectiveRunId,
            hookId: data.correlationId!,
            token: eventData.token,
            metadata: eventData.metadata as SerializedContent,
            ownerId: '', // TODO: get from context
            projectId: '', // TODO: get from context
            environment: '', // TODO: get from context
            // Propagate specVersion from the event to the hook entity
            specVersion: effectiveSpecVersion,
            isWebhook: eventData.isWebhook,
          })
          .onConflictDoNothing()
          .returning();
        if (hookValue) {
          hookValue.metadata ||= hookValue.metadataJson;
          hook = HookSchema.parse(compact(hookValue));
        }
      }

      // Handle hook_disposed event: delete hook entity atomically.
      // Uses DELETE ... RETURNING to ensure only one concurrent caller
      // succeeds — if no rows are returned, the hook was already disposed.
      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const [deleted] = await drizzle
          .delete(Schema.hooks)
          .where(eq(Schema.hooks.hookId, data.correlationId))
          .returning({ hookId: Schema.hooks.hookId });
        if (!deleted) {
          throw new EntityConflictError(
            `Hook "${data.correlationId}" already disposed`
          );
        }
      }

      // Handle wait_created event: create wait entity
      if (data.eventType === 'wait_created') {
        const eventData = (data as any).eventData as {
          resumeAt?: Date;
        };
        const waitId = `${effectiveRunId}-${data.correlationId}`;
        const [waitValue] = await drizzle
          .insert(Schema.waits)
          .values({
            waitId,
            runId: effectiveRunId,
            status: 'waiting',
            resumeAt: eventData.resumeAt,
            specVersion: effectiveSpecVersion,
          })
          .onConflictDoNothing()
          .returning();
        if (waitValue) {
          wait = {
            waitId: waitValue.waitId,
            runId: waitValue.runId,
            status: waitValue.status,
            resumeAt: waitValue.resumeAt ?? undefined,
            completedAt: waitValue.completedAt ?? undefined,
            createdAt: waitValue.createdAt,
            updatedAt: waitValue.updatedAt,
            specVersion: waitValue.specVersion ?? undefined,
          };
        } else {
          throw new EntityConflictError(
            `Wait "${data.correlationId}" already exists`
          );
        }
      }

      // Handle wait_completed event: transition wait to 'completed'
      // Uses conditional UPDATE to reject duplicate completions (same pattern as step_completed)
      if (data.eventType === 'wait_completed') {
        const waitId = `${effectiveRunId}-${data.correlationId}`;
        const [waitValue] = await drizzle
          .update(Schema.waits)
          .set({
            status: 'completed',
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.waits.waitId, waitId),
              eq(Schema.waits.status, 'waiting')
            )
          )
          .returning();
        if (waitValue) {
          wait = {
            waitId: waitValue.waitId,
            runId: waitValue.runId,
            status: waitValue.status,
            resumeAt: waitValue.resumeAt ?? undefined,
            completedAt: waitValue.completedAt ?? undefined,
            createdAt: waitValue.createdAt,
            updatedAt: waitValue.updatedAt,
            specVersion: waitValue.specVersion ?? undefined,
          };
        } else {
          // Wait not updated - check if it exists and why
          const [existing] = await getWaitForValidation.execute({
            waitId,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Wait "${data.correlationId}" not found`
            );
          }
          if (existing.status === 'completed') {
            throw new EntityConflictError(
              `Wait "${data.correlationId}" already completed`
            );
          }
        }
      }

      // Strip eventData from run_started — it belongs on run_created only.
      const storedEventData =
        data.eventType === 'run_started'
          ? undefined
          : 'eventData' in data
            ? data.eventData
            : undefined;

      const [value] = await drizzle
        .insert(events)
        .values({
          runId: effectiveRunId,
          eventId,
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: storedEventData,
          specVersion: effectiveSpecVersion,
        })
        .returning({ createdAt: events.createdAt });
      if (!value) {
        throw new EntityConflictError(`Event ${eventId} could not be created`);
      }
      const result = {
        ...data,
        ...value,
        runId: effectiveRunId,
        eventId,
        ...(storedEventData !== undefined
          ? { eventData: storedEventData }
          : {}),
      };
      // Strip eventData leaked by ...data spread for run_started events.
      // The eventData (run input for resilient start) belongs on
      // run_created only; storedEventData is already undefined above.
      if (data.eventType === 'run_started') {
        delete (result as any).eventData;
      }
      const parsed = EventSchema.parse(result);
      const resolveData = params?.resolveData ?? 'all';

      // For run_started: include all events so the runtime can skip
      // the initial events.list call and reduce TTFB.
      let allEvents: Event[] | undefined;
      if (data.eventType === 'run_started' && run) {
        const eventRows = await drizzle
          .select()
          .from(Schema.events)
          .where(eq(Schema.events.runId, effectiveRunId))
          .orderBy(Schema.events.eventId);
        allEvents = eventRows.map((e) => {
          e.eventData ||= e.eventDataJson;
          const parsed = EventSchema.parse(compact(e));
          return stripEventDataRefs(parsed, resolveData);
        });
      }

      return {
        event: stripEventDataRefs(parsed, resolveData),
        run,
        step,
        hook,
        wait,
        events: allEvents,
      };
    },
    async get(
      runId: string,
      eventId: string,
      params?: GetEventParams
    ): Promise<Event> {
      const [value] = await drizzle
        .select()
        .from(events)
        .where(and(eq(events.runId, runId), eq(events.eventId, eventId)))
        .limit(1);

      if (!value) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`);
      }

      value.eventData ||= value.eventDataJson;
      const parsed = EventSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return stripEventDataRefs(parsed, resolveData);
    },
    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.runId, params.runId),
            map(params.pagination?.cursor, (c) =>
              order.compare(events.eventId, c)
            )
          )
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.eventData ||= v.eventDataJson;
          const parsed = EventSchema.parse(compact(v));
          return stripEventDataRefs(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore: all.length > limit,
      };
    },
    async listByCorrelationId(params) {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.correlationId, params.correlationId),
            map(params.pagination?.cursor, (c) =>
              order.compare(events.eventId, c)
            )
          )
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.eventData ||= v.eventDataJson;
          const parsed = EventSchema.parse(compact(v));
          return stripEventDataRefs(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore: all.length > limit,
      };
    },
  };
}

export function createHooksStorage(drizzle: Drizzle): Storage['hooks'] {
  const { hooks } = Schema;
  const getByToken = drizzle
    .select()
    .from(hooks)
    .where(eq(hooks.token, sql.placeholder('token')))
    .limit(1)
    .prepare('workflow_hooks_get_by_token');

  return {
    async get(hookId, params) {
      const [value] = await drizzle
        .select()
        .from(hooks)
        .where(eq(hooks.hookId, hookId))
        .limit(1);
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      parsed.isWebhook ??= true;
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async getByToken(token, params) {
      const [value] = await getByToken.execute({ token });
      if (!value) {
        throw new HookNotFoundError(token);
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      parsed.isWebhook ??= true;
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async list(params: ListHooksParams) {
      const limit = params?.pagination?.limit ?? 100;
      const fromCursor = params?.pagination?.cursor;
      const sortOrder = params?.pagination?.sortOrder ?? 'asc';
      const orderFn = sortOrder === 'asc' ? asc : desc;
      const cursorFn = sortOrder === 'asc' ? gt : lt;
      const all = await drizzle
        .select()
        .from(hooks)
        .where(
          and(
            map(params.runId, (id) => eq(hooks.runId, id)),
            map(fromCursor, (c) => cursorFn(hooks.hookId, c))
          )
        )
        .orderBy(orderFn(hooks.hookId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.metadata ||= v.metadataJson;
          const parsed = HookSchema.parse(compact(v));
          return filterHookData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },
  };
}

export function createStepsStorage(drizzle: Drizzle): Storage['steps'] {
  const { steps } = Schema;

  return {
    get: (async (runId, stepId, params) => {
      const [value] = await drizzle
        .select()
        .from(steps)
        .where(and(eq(steps.runId, runId), eq(steps.stepId, stepId)))
        .limit(1);

      if (!value) {
        throw new WorkflowWorldError(`Step not found: ${stepId}`);
      }
      value.output ||= value.outputJson;
      value.input ||= value.inputJson;
      value.error ||= parseErrorJson(value.errorJson);
      const deserialized = deserializeStepError(compact(value));
      const parsed = StepSchema.parse(deserialized);
      const resolveData = params?.resolveData ?? 'all';
      return filterStepData(parsed, resolveData);
    }) as Storage['steps']['get'],
    list: (async (params) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(steps)
        .where(
          and(
            eq(steps.runId, params.runId),
            map(fromCursor, (c) => lt(steps.stepId, c))
          )
        )
        .orderBy(desc(steps.stepId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.output ||= v.outputJson;
          v.input ||= v.inputJson;
          v.error ||= parseErrorJson(v.errorJson);
          const deserialized = deserializeStepError(compact(v));
          const parsed = StepSchema.parse(deserialized);
          return filterStepData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.stepId ?? null,
      };
    }) as Storage['steps']['list'],
  };
}

function filterStepData(step: Step, resolveData: 'none'): StepWithoutData;
function filterStepData(step: Step, resolveData: 'all'): Step;
function filterStepData(
  step: Step,
  resolveData: ResolveData
): Step | StepWithoutData;
function filterStepData(
  step: Step,
  resolveData: ResolveData
): Step | StepWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = step;

    return { input: undefined, output: undefined, ...rest };
  }
  return step;
}

function filterRunData(
  run: WorkflowRun,
  resolveData: 'none'
): WorkflowRunWithoutData;
function filterRunData(run: WorkflowRun, resolveData: 'all'): WorkflowRun;
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData
): WorkflowRun | WorkflowRunWithoutData;
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData
): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = run;

    return { input: undefined, output: undefined, ...rest };
  }
  return run;
}

function filterHookData(hook: Hook, resolveData: ResolveData): Hook {
  if (resolveData === 'none' && 'metadata' in hook) {
    const { metadata: _, ...rest } = hook;

    return { metadata: undefined, ...rest };
  }
  return hook;
}
