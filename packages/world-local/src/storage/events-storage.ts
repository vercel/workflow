import path from 'node:path';
import { RunNotSupportedError, WorkflowAPIError } from '@workflow/errors';
import type {
  Event,
  EventResult,
  Hook,
  Step,
  Storage,
  WorkflowRun,
} from '@workflow/world';
import {
  EventSchema,
  HookSchema,
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  deleteJSON,
  listJSONFiles,
  paginatedFileSystemQuery,
  readJSON,
  writeJSON,
} from '../fs.js';
import { filterEventData } from './filters.js';
import { getObjectCreatedAt, monotonicUlid } from './helpers.js';
import { deleteAllHooksForRun } from './hooks-storage.js';
import { handleLegacyEvent } from './legacy.js';

/**
 * Creates the events storage implementation using the filesystem.
 * Implements the Storage['events'] interface with create, list, and listByCorrelationId operations.
 */
export function createEventsStorage(basedir: string): Storage['events'] {
  return {
    async create(runId, data, params): Promise<EventResult> {
      const eventId = `evnt_${monotonicUlid()}`;
      const now = new Date();

      // For run_created events, generate runId server-side if null or empty
      let effectiveRunId: string;
      if (data.eventType === 'run_created' && (!runId || runId === '')) {
        effectiveRunId = `wrun_${monotonicUlid()}`;
      } else if (!runId) {
        throw new Error('runId is required for non-run_created events');
      } else {
        effectiveRunId = runId;
      }

      // Helper to check if run is in terminal state
      const isRunTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      // Helper to check if step is in terminal state
      const isStepTerminal = (status: string) =>
        ['completed', 'failed'].includes(status);

      // Get current run state for validation (if not creating a new run)
      // Skip run validation for step_completed and step_retrying - they only operate
      // on running steps, and running steps are always allowed to modify regardless
      // of run state. This optimization saves filesystem reads per step event.
      let currentRun: WorkflowRun | null = null;
      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (
        data.eventType !== 'run_created' &&
        !skipRunValidationEvents.includes(data.eventType)
      ) {
        const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
        currentRun = await readJSON(runPath, WorkflowRunSchema);
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
          return handleLegacyEvent(
            basedir,
            effectiveRunId,
            data,
            currentRun,
            params
          );
        }
      }

      // ============================================================
      // VALIDATION: Terminal state and event ordering checks
      // ============================================================

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
          // Return existing state (idempotent)
          const event: Event = {
            ...data,
            runId: effectiveRunId,
            eventId,
            createdAt: now,
            specVersion: SPEC_VERSION_CURRENT,
          };
          const compositeKey = `${effectiveRunId}-${eventId}`;
          const eventPath = path.join(
            basedir,
            'events',
            `${compositeKey}.json`
          );
          await writeJSON(eventPath, event);
          const resolveData =
            params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
          return {
            event: filterEventData(event, resolveData),
            run: currentRun,
          };
        }

        // Run state transitions are not allowed on terminal runs
        if (
          runTerminalEvents.includes(data.eventType) ||
          data.eventType === 'run_cancelled'
        ) {
          throw new WorkflowAPIError(
            `Cannot transition run from terminal state "${currentRun.status}"`,
            { status: 410 }
          );
        }

        // Creating new entities on terminal runs is not allowed
        if (
          data.eventType === 'step_created' ||
          data.eventType === 'hook_created'
        ) {
          throw new WorkflowAPIError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`,
            { status: 410 }
          );
        }
      }

      // Step-related event validation (ordering and terminal state)
      // Store existingStep so we can reuse it later (avoid double read)
      let validatedStep: Step | null = null;
      const stepEvents = [
        'step_started',
        'step_completed',
        'step_failed',
        'step_retrying',
      ];
      if (stepEvents.includes(data.eventType) && data.correlationId) {
        const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
        const stepPath = path.join(
          basedir,
          'steps',
          `${stepCompositeKey}.json`
        );
        validatedStep = await readJSON(stepPath, StepSchema);

        // Event ordering: step must exist before these events
        if (!validatedStep) {
          throw new WorkflowAPIError(`Step "${data.correlationId}" not found`, {
            status: 404,
          });
        }

        // Step terminal state validation
        if (isStepTerminal(validatedStep.status)) {
          throw new WorkflowAPIError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
            { status: 410 }
          );
        }

        // On terminal runs: only allow completing/failing in-progress steps
        if (currentRun && isRunTerminal(currentRun.status)) {
          if (validatedStep.status !== 'running') {
            throw new WorkflowAPIError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
              { status: 410 }
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
        const hookPath = path.join(
          basedir,
          'hooks',
          `${data.correlationId}.json`
        );
        const existingHook = await readJSON(hookPath, HookSchema);

        if (!existingHook) {
          throw new WorkflowAPIError(`Hook "${data.correlationId}" not found`, {
            status: 404,
          });
        }
      }

      const event: Event = {
        ...data,
        runId: effectiveRunId,
        eventId,
        createdAt: now,
        specVersion: SPEC_VERSION_CURRENT,
      };

      // Track entity created/updated for EventResult
      let run: WorkflowRun | undefined;
      let step: Step | undefined;
      let hook: Hook | undefined;

      // Create/update entity based on event type (event-sourced architecture)
      // Run lifecycle events
      if (data.eventType === 'run_created' && 'eventData' in data) {
        const runData = data.eventData as {
          deploymentId: string;
          workflowName: string;
          input: any[];
          executionContext?: Record<string, any>;
          specVersion?: number;
        };
        run = {
          runId: effectiveRunId,
          deploymentId: runData.deploymentId,
          status: 'pending',
          workflowName: runData.workflowName,
          // Always use current world spec version
          specVersion: SPEC_VERSION_CURRENT,
          executionContext: runData.executionContext,
          input: runData.input || [],
          output: undefined,
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };
        const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
        await writeJSON(runPath, run);
      } else if (data.eventType === 'run_started') {
        // Reuse currentRun from validation (already read above)
        if (currentRun) {
          const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
          run = {
            runId: currentRun.runId,
            deploymentId: currentRun.deploymentId,
            workflowName: currentRun.workflowName,
            specVersion: currentRun.specVersion,
            executionContext: currentRun.executionContext,
            input: currentRun.input,
            createdAt: currentRun.createdAt,
            expiredAt: currentRun.expiredAt,
            status: 'running',
            output: undefined,
            error: undefined,
            completedAt: undefined,
            startedAt: currentRun.startedAt ?? now,
            updatedAt: now,
          };
          await writeJSON(runPath, run, { overwrite: true });
        }
      } else if (data.eventType === 'run_completed' && 'eventData' in data) {
        const completedData = data.eventData as { output?: any };
        // Reuse currentRun from validation (already read above)
        if (currentRun) {
          const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
          run = {
            runId: currentRun.runId,
            deploymentId: currentRun.deploymentId,
            workflowName: currentRun.workflowName,
            specVersion: currentRun.specVersion,
            executionContext: currentRun.executionContext,
            input: currentRun.input,
            createdAt: currentRun.createdAt,
            expiredAt: currentRun.expiredAt,
            startedAt: currentRun.startedAt,
            status: 'completed',
            output: completedData.output,
            error: undefined,
            completedAt: now,
            updatedAt: now,
          };
          await writeJSON(runPath, run, { overwrite: true });
          await deleteAllHooksForRun(basedir, effectiveRunId);
        }
      } else if (data.eventType === 'run_failed' && 'eventData' in data) {
        const failedData = data.eventData as {
          error: any;
          errorCode?: string;
        };
        // Reuse currentRun from validation (already read above)
        if (currentRun) {
          const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
          run = {
            runId: currentRun.runId,
            deploymentId: currentRun.deploymentId,
            workflowName: currentRun.workflowName,
            specVersion: currentRun.specVersion,
            executionContext: currentRun.executionContext,
            input: currentRun.input,
            createdAt: currentRun.createdAt,
            expiredAt: currentRun.expiredAt,
            startedAt: currentRun.startedAt,
            status: 'failed',
            output: undefined,
            error: {
              message:
                typeof failedData.error === 'string'
                  ? failedData.error
                  : (failedData.error?.message ?? 'Unknown error'),
              stack: failedData.error?.stack,
              code: failedData.errorCode,
            },
            completedAt: now,
            updatedAt: now,
          };
          await writeJSON(runPath, run, { overwrite: true });
          await deleteAllHooksForRun(basedir, effectiveRunId);
        }
      } else if (data.eventType === 'run_cancelled') {
        // Reuse currentRun from validation (already read above)
        if (currentRun) {
          const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
          run = {
            runId: currentRun.runId,
            deploymentId: currentRun.deploymentId,
            workflowName: currentRun.workflowName,
            specVersion: currentRun.specVersion,
            executionContext: currentRun.executionContext,
            input: currentRun.input,
            createdAt: currentRun.createdAt,
            expiredAt: currentRun.expiredAt,
            startedAt: currentRun.startedAt,
            status: 'cancelled',
            output: undefined,
            error: undefined,
            completedAt: now,
            updatedAt: now,
          };
          await writeJSON(runPath, run, { overwrite: true });
          await deleteAllHooksForRun(basedir, effectiveRunId);
        }
      } else if (
        // Step lifecycle events
        data.eventType === 'step_created' &&
        'eventData' in data
      ) {
        // step_created: Creates step entity with status 'pending', attempt=0, createdAt set
        const stepData = data.eventData as {
          stepName: string;
          input: any;
        };
        step = {
          runId: effectiveRunId,
          stepId: data.correlationId,
          stepName: stepData.stepName,
          status: 'pending',
          input: stepData.input,
          output: undefined,
          error: undefined,
          attempt: 0,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
          specVersion: SPEC_VERSION_CURRENT,
        };
        const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
        const stepPath = path.join(
          basedir,
          'steps',
          `${stepCompositeKey}.json`
        );
        await writeJSON(stepPath, step);
      } else if (data.eventType === 'step_started') {
        // step_started: Increments attempt, sets status to 'running'
        // Sets startedAt only on the first start (not updated on retries)
        // Reuse validatedStep from validation (already read above)
        if (validatedStep) {
          const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
          const stepPath = path.join(
            basedir,
            'steps',
            `${stepCompositeKey}.json`
          );
          step = {
            ...validatedStep,
            status: 'running',
            // Only set startedAt on the first start
            startedAt: validatedStep.startedAt ?? now,
            // Increment attempt counter on every start
            attempt: validatedStep.attempt + 1,
            updatedAt: now,
          };
          await writeJSON(stepPath, step, { overwrite: true });
        }
      } else if (data.eventType === 'step_completed' && 'eventData' in data) {
        // step_completed: Terminal state with output
        // Reuse validatedStep from validation (already read above)
        const completedData = data.eventData as { result: any };
        if (validatedStep) {
          const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
          const stepPath = path.join(
            basedir,
            'steps',
            `${stepCompositeKey}.json`
          );
          step = {
            ...validatedStep,
            status: 'completed',
            output: completedData.result,
            completedAt: now,
            updatedAt: now,
          };
          await writeJSON(stepPath, step, { overwrite: true });
        }
      } else if (data.eventType === 'step_failed' && 'eventData' in data) {
        // step_failed: Terminal state with error
        // Reuse validatedStep from validation (already read above)
        const failedData = data.eventData as {
          error: any;
          stack?: string;
        };
        if (validatedStep) {
          const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
          const stepPath = path.join(
            basedir,
            'steps',
            `${stepCompositeKey}.json`
          );
          const error = {
            message:
              typeof failedData.error === 'string'
                ? failedData.error
                : (failedData.error?.message ?? 'Unknown error'),
            stack: failedData.stack,
          };
          step = {
            ...validatedStep,
            status: 'failed',
            error,
            completedAt: now,
            updatedAt: now,
          };
          await writeJSON(stepPath, step, { overwrite: true });
        }
      } else if (data.eventType === 'step_retrying' && 'eventData' in data) {
        // step_retrying: Sets status back to 'pending', records error
        // Reuse validatedStep from validation (already read above)
        const retryData = data.eventData as {
          error: any;
          stack?: string;
          retryAfter?: Date;
        };
        if (validatedStep) {
          const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
          const stepPath = path.join(
            basedir,
            'steps',
            `${stepCompositeKey}.json`
          );
          step = {
            ...validatedStep,
            status: 'pending',
            error: {
              message:
                typeof retryData.error === 'string'
                  ? retryData.error
                  : (retryData.error?.message ?? 'Unknown error'),
              stack: retryData.stack,
            },
            retryAfter: retryData.retryAfter,
            updatedAt: now,
          };
          await writeJSON(stepPath, step, { overwrite: true });
        }
      } else if (
        // Hook lifecycle events
        data.eventType === 'hook_created' &&
        'eventData' in data
      ) {
        const hookData = data.eventData as {
          token: string;
          metadata?: any;
        };

        // Check for duplicate token before creating hook
        const hooksDir = path.join(basedir, 'hooks');
        const hookFiles = await listJSONFiles(hooksDir);
        let hasConflict = false;
        for (const file of hookFiles) {
          const existingHookPath = path.join(hooksDir, `${file}.json`);
          const existingHook = await readJSON(existingHookPath, HookSchema);
          if (existingHook && existingHook.token === hookData.token) {
            hasConflict = true;
            break;
          }
        }

        if (hasConflict) {
          // Create hook_conflict event instead of hook_created
          // This allows the workflow to continue and fail gracefully when the hook is awaited
          const conflictEvent: Event = {
            eventType: 'hook_conflict',
            correlationId: data.correlationId,
            eventData: {
              token: hookData.token,
            },
            runId: effectiveRunId,
            eventId,
            createdAt: now,
            specVersion: SPEC_VERSION_CURRENT,
          };

          // Store the conflict event
          const compositeKey = `${effectiveRunId}-${eventId}`;
          const eventPath = path.join(
            basedir,
            'events',
            `${compositeKey}.json`
          );
          await writeJSON(eventPath, conflictEvent);

          const resolveData =
            params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
          const filteredEvent = filterEventData(conflictEvent, resolveData);

          // Return EventResult with conflict event (no hook entity created)
          return {
            event: filteredEvent,
            run,
            step,
            hook: undefined,
          };
        }

        hook = {
          runId: effectiveRunId,
          hookId: data.correlationId,
          token: hookData.token,
          metadata: hookData.metadata,
          ownerId: 'local-owner',
          projectId: 'local-project',
          environment: 'local',
          createdAt: now,
          specVersion: SPEC_VERSION_CURRENT,
        };
        const hookPath = path.join(
          basedir,
          'hooks',
          `${data.correlationId}.json`
        );
        await writeJSON(hookPath, hook);
      } else if (data.eventType === 'hook_disposed') {
        // Delete the hook when disposed
        const hookPath = path.join(
          basedir,
          'hooks',
          `${data.correlationId}.json`
        );
        await deleteJSON(hookPath);
      }
      // Note: hook_received events are stored in the event log but don't
      // modify the Hook entity (which doesn't have a payload field)

      // Store event using composite key {runId}-{eventId}
      const compositeKey = `${effectiveRunId}-${eventId}`;
      const eventPath = path.join(basedir, 'events', `${compositeKey}.json`);
      await writeJSON(eventPath, event);

      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const filteredEvent = filterEventData(event, resolveData);

      // Return EventResult with event and any created/updated entity
      return {
        event: filteredEvent,
        run,
        step,
        hook,
      };
    },

    async list(params) {
      const { runId } = params;
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = await paginatedFileSystemQuery({
        directory: path.join(basedir, 'events'),
        schema: EventSchema,
        filePrefix: `${runId}-`,
        // Events in chronological order (oldest first) by default,
        // different from the default for other list calls.
        sortOrder: params.pagination?.sortOrder ?? 'asc',
        limit: params.pagination?.limit,
        cursor: params.pagination?.cursor,
        getCreatedAt: getObjectCreatedAt('evnt'),
        getId: (event) => event.eventId,
      });

      // If resolveData is "none", remove eventData from events
      if (resolveData === 'none') {
        return {
          ...result,
          data: result.data.map((event) => {
            const { eventData: _eventData, ...rest } = event as any;
            return rest;
          }),
        };
      }

      return result;
    },

    async listByCorrelationId(params) {
      const correlationId = params.correlationId;
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = await paginatedFileSystemQuery({
        directory: path.join(basedir, 'events'),
        schema: EventSchema,
        // No filePrefix - search all events
        filter: (event) => event.correlationId === correlationId,
        // Events in chronological order (oldest first) by default,
        // different from the default for other list calls.
        sortOrder: params.pagination?.sortOrder ?? 'asc',
        limit: params.pagination?.limit,
        cursor: params.pagination?.cursor,
        getCreatedAt: getObjectCreatedAt('evnt'),
        getId: (event) => event.eventId,
      });

      // If resolveData is "none", remove eventData from events
      if (resolveData === 'none') {
        return {
          ...result,
          data: result.data.map((event) => {
            const { eventData: _eventData, ...rest } = event as any;
            return rest;
          }),
        };
      }

      return result;
    },
  };
}
