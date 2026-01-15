import path from 'node:path';
import {
  RunNotSupportedError,
  WorkflowAPIError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import {
  type Event,
  type EventResult,
  EventSchema,
  type GetHookParams,
  type Hook,
  HookSchema,
  isLegacySpecVersion,
  type ListHooksParams,
  type PaginatedResponse,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  type Step,
  StepSchema,
  type Storage,
  type WorkflowRun,
  WorkflowRunSchema,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { DEFAULT_RESOLVE_DATA_OPTION } from './config.js';
import {
  deleteJSON,
  listJSONFiles,
  paginatedFileSystemQuery,
  readJSON,
  ulidToDate,
  writeJSON,
} from './fs.js';

// Create a monotonic ULID factory that ensures ULIDs are always increasing
// even when generated within the same millisecond
const monotonicUlid = monotonicFactory(() => Math.random());

// Helper functions to filter data based on resolveData setting
function filterRunData(
  run: WorkflowRun,
  resolveData: 'none' | 'all'
): WorkflowRun {
  if (resolveData === 'none') {
    return {
      ...run,
      input: [],
      output: undefined,
    };
  }
  return run;
}

function filterStepData(step: Step, resolveData: 'none' | 'all'): Step {
  if (resolveData === 'none') {
    return {
      ...step,
      input: [],
      output: undefined,
    };
  }
  return step;
}

function filterEventData(event: Event, resolveData: 'none' | 'all'): Event {
  if (resolveData === 'none') {
    const { eventData: _eventData, ...rest } = event as any;
    return rest;
  }
  return event;
}

function filterHookData(hook: Hook, resolveData: 'none' | 'all'): Hook {
  if (resolveData === 'none') {
    const { metadata: _metadata, ...rest } = hook as any;
    return rest;
  }
  return hook;
}

const getObjectCreatedAt =
  (idPrefix: string) =>
  (filename: string): Date | null => {
    const replaceRegex = new RegExp(`^${idPrefix}_`, 'g');
    const dashIndex = filename.indexOf('-');

    if (dashIndex === -1) {
      // No dash - extract ULID from the filename (e.g., wrun_ULID.json, evnt_ULID.json)
      const ulid = filename.replace(/\.json$/, '').replace(replaceRegex, '');
      return ulidToDate(ulid);
    }

    // For composite keys like {runId}-{stepId}, extract from the appropriate part
    if (idPrefix === 'step') {
      // Steps use sequential IDs (step_0, step_1, etc.) - no timestamp in filename.
      // Return null to skip filename-based optimization and defer to JSON-based filtering.
      return null;
    }

    // For events: wrun_ULID-evnt_ULID.json - extract from the eventId part
    const id = filename.substring(dashIndex + 1).replace(/\.json$/, '');
    const ulid = id.replace(replaceRegex, '');
    return ulidToDate(ulid);
  };

/**
 * Creates a hooks storage implementation using the filesystem.
 * Implements the Storage['hooks'] interface with hook CRUD operations.
 */
function createHooksStorage(basedir: string): Storage['hooks'] {
  // Helper function to find a hook by token (shared between getByToken)
  async function findHookByToken(token: string): Promise<Hook | null> {
    const hooksDir = path.join(basedir, 'hooks');
    const files = await listJSONFiles(hooksDir);

    for (const file of files) {
      const hookPath = path.join(hooksDir, `${file}.json`);
      const hook = await readJSON(hookPath, HookSchema);
      if (hook && hook.token === token) {
        return hook;
      }
    }

    return null;
  }

  async function get(hookId: string, params?: GetHookParams): Promise<Hook> {
    const hookPath = path.join(basedir, 'hooks', `${hookId}.json`);
    const hook = await readJSON(hookPath, HookSchema);
    if (!hook) {
      throw new Error(`Hook ${hookId} not found`);
    }
    const resolveData = params?.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
    return filterHookData(hook, resolveData);
  }

  async function getByToken(token: string): Promise<Hook> {
    const hook = await findHookByToken(token);
    if (!hook) {
      throw new Error(`Hook with token ${token} not found`);
    }
    return hook;
  }

  async function list(
    params: ListHooksParams
  ): Promise<PaginatedResponse<Hook>> {
    const hooksDir = path.join(basedir, 'hooks');
    const resolveData = params.resolveData || DEFAULT_RESOLVE_DATA_OPTION;

    const result = await paginatedFileSystemQuery({
      directory: hooksDir,
      schema: HookSchema,
      sortOrder: params.pagination?.sortOrder,
      limit: params.pagination?.limit,
      cursor: params.pagination?.cursor,
      filePrefix: undefined, // Hooks don't have ULIDs, so we can't optimize by filename
      filter: (hook) => {
        // Filter by runId if provided
        if (params.runId && hook.runId !== params.runId) {
          return false;
        }
        return true;
      },
      getCreatedAt: () => {
        // Hook files don't have ULID timestamps in filename
        // We need to read the file to get createdAt, but that's inefficient
        // So we return the hook's createdAt directly (item.createdAt will be used for sorting)
        // Return a dummy date to pass the null check, actual sorting uses item.createdAt
        return new Date(0);
      },
      getId: (hook) => hook.hookId,
    });

    // Transform the data after pagination
    return {
      ...result,
      data: result.data.map((hook) => filterHookData(hook, resolveData)),
    };
  }

  return { get, getByToken, list };
}

/**
 * Helper function to delete all hooks associated with a workflow run
 */
async function deleteAllHooksForRun(
  basedir: string,
  runId: string
): Promise<void> {
  const hooksDir = path.join(basedir, 'hooks');
  const files = await listJSONFiles(hooksDir);

  for (const file of files) {
    const hookPath = path.join(hooksDir, `${file}.json`);
    const hook = await readJSON(hookPath, HookSchema);
    if (hook && hook.runId === runId) {
      await deleteJSON(hookPath);
    }
  }
}

/**
 * Handle events for legacy runs (pre-event-sourcing, specVersion < 4.1).
 * Legacy runs use different behavior:
 * - run_cancelled: Skip event storage, directly update run
 * - wait_completed: Store event only (no entity mutation)
 * - Other events: Throw error (not supported for legacy runs)
 */
async function handleLegacyEvent(
  basedir: string,
  runId: string,
  data: any,
  currentRun: WorkflowRun,
  params?: { resolveData?: 'none' | 'all' }
): Promise<EventResult> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;

  switch (data.eventType) {
    case 'run_cancelled': {
      // Legacy: Skip event storage, directly update run to cancelled
      const now = new Date();
      const run: WorkflowRun = {
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
      const runPath = path.join(basedir, 'runs', `${runId}.json`);
      await writeJSON(runPath, run, { overwrite: true });
      await deleteAllHooksForRun(basedir, runId);
      // Return without event (legacy behavior skips event storage)
      return { event: undefined, run: filterRunData(run, resolveData) };
    }

    case 'wait_completed': {
      // Legacy: Store event only (no entity mutation)
      const eventId = `evnt_${monotonicUlid()}`;
      const now = new Date();
      const event: Event = {
        ...data,
        runId,
        eventId,
        createdAt: now,
        specVersion: SPEC_VERSION_CURRENT,
      };
      const compositeKey = `${runId}-${eventId}`;
      const eventPath = path.join(basedir, 'events', `${compositeKey}.json`);
      await writeJSON(eventPath, event);
      return { event: filterEventData(event, resolveData) };
    }

    default:
      throw new Error(
        `Event type '${data.eventType}' not supported for legacy runs ` +
          `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
          `Please upgrade @workflow packages.`
      );
  }
}

export function createStorage(basedir: string): Storage {
  return {
    runs: {
      async get(id, params) {
        const runPath = path.join(basedir, 'runs', `${id}.json`);
        const run = await readJSON(runPath, WorkflowRunSchema);
        if (!run) {
          throw new WorkflowRunNotFoundError(id);
        }
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterRunData(run, resolveData);
      },

      async list(params) {
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        const result = await paginatedFileSystemQuery({
          directory: path.join(basedir, 'runs'),
          schema: WorkflowRunSchema,
          filter: (run) => {
            if (
              params?.workflowName &&
              run.workflowName !== params.workflowName
            ) {
              return false;
            }
            if (params?.status && run.status !== params.status) {
              return false;
            }
            return true;
          },
          sortOrder: params?.pagination?.sortOrder ?? 'desc',
          limit: params?.pagination?.limit,
          cursor: params?.pagination?.cursor,
          getCreatedAt: getObjectCreatedAt('wrun'),
          getId: (run) => run.runId,
        });

        // If resolveData is "none", replace input/output with empty data
        if (resolveData === 'none') {
          return {
            ...result,
            data: result.data.map((run) => ({
              ...run,
              input: [],
              output: undefined,
            })),
          };
        }

        return result;
      },
    },

    steps: {
      async get(
        runId: string | undefined,
        stepId: string,
        params
      ): Promise<Step> {
        if (!runId) {
          const fileIds = await listJSONFiles(path.join(basedir, 'steps'));
          const fileId = fileIds.find((fileId) =>
            fileId.endsWith(`-${stepId}`)
          );
          if (!fileId) {
            throw new Error(`Step ${stepId} not found`);
          }
          runId = fileId.split('-')[0];
        }
        const compositeKey = `${runId}-${stepId}`;
        const stepPath = path.join(basedir, 'steps', `${compositeKey}.json`);
        const step = await readJSON(stepPath, StepSchema);
        if (!step) {
          throw new Error(`Step ${stepId} in run ${runId} not found`);
        }
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterStepData(step, resolveData);
      },

      async list(params) {
        const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        const result = await paginatedFileSystemQuery({
          directory: path.join(basedir, 'steps'),
          schema: StepSchema,
          filePrefix: `${params.runId}-`,
          sortOrder: params.pagination?.sortOrder ?? 'desc',
          limit: params.pagination?.limit,
          cursor: params.pagination?.cursor,
          getCreatedAt: getObjectCreatedAt('step'),
          getId: (step) => step.stepId,
        });

        // If resolveData is "none", replace input/output with empty data
        if (resolveData === 'none') {
          return {
            ...result,
            data: result.data.map((step) => ({
              ...step,
              input: [],
              output: undefined,
            })),
          };
        }

        return result;
      },
    },

    // Events - filesystem-backed storage
    events: {
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
            throw new WorkflowAPIError(
              `Step "${data.correlationId}" not found`,
              { status: 404 }
            );
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
            throw new WorkflowAPIError(
              `Hook "${data.correlationId}" not found`,
              { status: 404 }
            );
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
            const runPath = path.join(
              basedir,
              'runs',
              `${effectiveRunId}.json`
            );
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
            const runPath = path.join(
              basedir,
              'runs',
              `${effectiveRunId}.json`
            );
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
            const runPath = path.join(
              basedir,
              'runs',
              `${effectiveRunId}.json`
            );
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
            const runPath = path.join(
              basedir,
              'runs',
              `${effectiveRunId}.json`
            );
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
    },

    // Hooks
    hooks: createHooksStorage(basedir),
  };
}
