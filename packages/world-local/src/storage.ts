import path from 'node:path';
import { WorkflowRunNotFoundError } from '@workflow/errors';
import {
  type CreateHookRequest,
  type Event,
  EventSchema,
  type GetHookParams,
  type Hook,
  HookSchema,
  type ListHooksParams,
  type PaginatedResponse,
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
  // Helper function to find a hook by token (shared between create and getByToken)
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

  async function create(runId: string, data: CreateHookRequest): Promise<Hook> {
    // Check if a hook with the same token already exists
    // Token uniqueness is enforced globally per local environment
    const existingHook = await findHookByToken(data.token);
    if (existingHook) {
      throw new Error(
        `Hook with token ${data.token} already exists for this project`
      );
    }

    const now = new Date();

    const result = {
      runId,
      hookId: data.hookId,
      token: data.token,
      metadata: data.metadata,
      ownerId: 'local-owner',
      projectId: 'local-project',
      environment: 'local',
      createdAt: now,
    } as Hook;

    const hookPath = path.join(basedir, 'hooks', `${data.hookId}.json`);
    HookSchema.parse(result);
    await writeJSON(hookPath, result);
    return result;
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

  async function dispose(hookId: string): Promise<Hook> {
    const hookPath = path.join(basedir, 'hooks', `${hookId}.json`);
    const hook = await readJSON(hookPath, HookSchema);
    if (!hook) {
      throw new Error(`Hook ${hookId} not found`);
    }
    await deleteJSON(hookPath);
    return hook;
  }

  return { create, get, getByToken, list, dispose };
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

export function createStorage(basedir: string): Storage {
  return {
    runs: {
      async create(data) {
        const runId = `wrun_${monotonicUlid()}`;
        const now = new Date();

        const result: WorkflowRun = {
          runId,
          deploymentId: data.deploymentId,
          status: 'pending',
          workflowName: data.workflowName,
          executionContext: data.executionContext as
            | Record<string, any>
            | undefined,
          input: (data.input as any[]) || [],
          output: undefined,
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };

        const runPath = path.join(basedir, 'runs', `${runId}.json`);
        WorkflowRunSchema.parse(result);
        await writeJSON(runPath, result);
        return result;
      },

      async get(id, params) {
        const runPath = path.join(basedir, 'runs', `${id}.json`);
        const run = await readJSON(runPath, WorkflowRunSchema);
        if (!run) {
          throw new WorkflowRunNotFoundError(id);
        }
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterRunData(run, resolveData);
      },

      /**
       * Updates a workflow run.
       *
       * Note: This operation is not atomic. Concurrent updates from multiple
       * processes may result in lost updates (last writer wins). This is an
       * inherent limitation of filesystem-based storage without locking.
       * For the local world, this is acceptable as it's typically
       * used in single-process scenarios.
       */
      async update(id, data) {
        const runPath = path.join(basedir, 'runs', `${id}.json`);
        const run = await readJSON(runPath, WorkflowRunSchema);
        if (!run) {
          throw new WorkflowRunNotFoundError(id);
        }

        const now = new Date();
        const updatedRun = {
          ...run,
          ...data,
          updatedAt: now,
        } as WorkflowRun;

        // Only set startedAt the first time the run transitions to 'running'
        if (data.status === 'running' && !updatedRun.startedAt) {
          updatedRun.startedAt = now;
        }

        const isBecomingTerminal =
          data.status === 'completed' ||
          data.status === 'failed' ||
          data.status === 'cancelled';

        if (isBecomingTerminal) {
          updatedRun.completedAt = now;
        }

        WorkflowRunSchema.parse(updatedRun);
        await writeJSON(runPath, updatedRun, { overwrite: true });

        // If transitioning to a terminal status, clean up all hooks for this run
        if (isBecomingTerminal) {
          await deleteAllHooksForRun(basedir, id);
        }

        return updatedRun;
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

      async cancel(id, params) {
        // This will call update which triggers hook cleanup automatically
        const run = await this.update(id, { status: 'cancelled' });
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterRunData(run, resolveData);
      },
    },

    steps: {
      async create(runId, data) {
        const now = new Date();

        const result: Step = {
          runId,
          stepId: data.stepId,
          stepName: data.stepName,
          status: 'pending',
          input: data.input as any[],
          output: undefined,
          error: undefined,
          attempt: 0,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };

        const compositeKey = `${runId}-${data.stepId}`;
        const stepPath = path.join(basedir, 'steps', `${compositeKey}.json`);
        StepSchema.parse(result);
        await writeJSON(stepPath, result);

        return result;
      },

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

      /**
       * Updates a step.
       *
       * Note: This operation is not atomic. Concurrent updates from multiple
       * processes may result in lost updates (last writer wins). This is an
       * inherent limitation of filesystem-based storage without locking.
       */
      async update(runId, stepId, data) {
        const compositeKey = `${runId}-${stepId}`;
        const stepPath = path.join(basedir, 'steps', `${compositeKey}.json`);
        const step = await readJSON(stepPath, StepSchema);
        if (!step) {
          throw new Error(`Step ${stepId} in run ${runId} not found`);
        }

        const now = new Date();
        const updatedStep: Step = {
          ...step,
          ...data,
          updatedAt: now,
        };

        // Only set startedAt the first time the step transitions to 'running'
        if (data.status === 'running' && !updatedStep.startedAt) {
          updatedStep.startedAt = now;
        }
        if (data.status === 'completed' || data.status === 'failed') {
          updatedStep.completedAt = now;
        }

        StepSchema.parse(updatedStep);
        await writeJSON(stepPath, updatedStep, { overwrite: true });
        return updatedStep;
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
      async create(runId, data, params) {
        const eventId = `evnt_${monotonicUlid()}`;
        const now = new Date();

        const result: Event = {
          ...data,
          runId,
          eventId,
          createdAt: now,
        };

        // Store event using composite key {runId}-{eventId}
        const compositeKey = `${runId}-${eventId}`;
        const eventPath = path.join(basedir, 'events', `${compositeKey}.json`);
        EventSchema.parse(result);
        await writeJSON(eventPath, result);

        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterEventData(result, resolveData);
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
