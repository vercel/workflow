import path from 'node:path';
import { WorkflowRunNotFoundError } from '@workflow/errors';
import {
  type Event,
  EventSchema,
  type Hook,
  HookSchema,
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
      // For steps: wrun_ULID-step_123.json - extract from the runId part
      const runId = filename.substring(0, dashIndex);
      const ulid = runId.replace(/^wrun_/, '');
      return ulidToDate(ulid);
    }

    // For events: wrun_ULID-evnt_ULID.json - extract from the eventId part
    const id = filename.substring(dashIndex + 1).replace(/\.json$/, '');
    const ulid = id.replace(replaceRegex, '');
    return ulidToDate(ulid);
  };

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
          errorCode: undefined,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };

        const runPath = path.join(basedir, 'runs', `${runId}.json`);
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

      async update(id, data) {
        const runPath = path.join(basedir, 'runs', `${id}.json`);
        const run = await readJSON(runPath, WorkflowRunSchema);
        if (!run) {
          throw new WorkflowRunNotFoundError(id);
        }

        const now = new Date();
        const updatedRun: WorkflowRun = {
          ...run,
          ...data,
          updatedAt: now,
        };

        // Only set startedAt the first time the run transitions to 'running'
        if (data.status === 'running' && !updatedRun.startedAt) {
          updatedRun.startedAt = now;
        }
        if (
          data.status === 'completed' ||
          data.status === 'failed' ||
          data.status === 'cancelled'
        ) {
          updatedRun.completedAt = now;
        }

        await writeJSON(runPath, updatedRun, { overwrite: true });
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
        const run = await this.update(id, { status: 'cancelled' });
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterRunData(run, resolveData);
      },

      async pause(id, params) {
        const run = await this.update(id, { status: 'paused' });
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return filterRunData(run, resolveData);
      },

      async resume(id, params) {
        const run = await this.update(id, { status: 'running' });
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
          errorCode: undefined,
          attempt: 0,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };

        const compositeKey = `${runId}-${data.stepId}`;
        const stepPath = path.join(basedir, 'steps', `${compositeKey}.json`);
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
    hooks: {
      async create(runId, data) {
        const now = new Date();

        const result = {
          runId,
          hookId: data.hookId,
          token: data.token,
          metadata: data.metadata,
          ownerId: 'embedded-owner',
          projectId: 'embedded-project',
          environment: 'embedded',
          createdAt: now,
        } as Hook;

        const hookPath = path.join(basedir, 'hooks', `${data.hookId}.json`);
        await writeJSON(hookPath, result);
        return result;
      },

      async get(hookId, params) {
        const hookPath = path.join(basedir, 'hooks', `${hookId}.json`);
        // Try webhook schema first (which includes response), fall back to HookSchema
        const hook = await readJSON(hookPath, HookSchema);
        if (!hook) {
          throw new Error(`Hook ${hookId} not found`);
        }
        const resolveData = params?.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
        return filterHookData(hook, resolveData);
      },

      async getByToken(token) {
        // Need to search through all hooks to find one with matching token
        const hooksDir = path.join(basedir, 'hooks');
        const files = await listJSONFiles(hooksDir);

        for (const file of files) {
          const hookPath = path.join(hooksDir, `${file}.json`);
          const hook = await readJSON(hookPath, HookSchema);
          if (hook && hook.token === token) {
            return hook;
          }
        }

        throw new Error(`Hook with token ${token} not found`);
      },

      async list(params) {
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
      },

      async dispose(hookId) {
        const hookPath = path.join(basedir, 'hooks', `${hookId}.json`);
        const hook = await readJSON(hookPath, HookSchema);
        if (!hook) {
          throw new Error(`Hook ${hookId} not found`);
        }
        await deleteJSON(hookPath);
        return hook;
      },
    },
  };
}
