import path from 'node:path';
import { WorkflowRunNotFoundError } from '@workflow/errors';
import type {
  AttributeChange,
  ExperimentalSetAttributesResult,
  ListWorkflowRunsParams,
  PaginatedResponse,
  Storage,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  applyAttributeChanges,
  AttributeValidationError,
  validateAttributeChanges,
  WorkflowRunSchema,
} from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  assertSafeEntityId,
  paginatedFileSystemQuery,
  readJSONWithFallback,
  taggedPath,
  writeJSON,
} from '../fs.js';
import { filterRunData } from './filters.js';
import { getObjectCreatedAt } from './helpers.js';

/**
 * Internal extension of `ListWorkflowRunsParams` that adds a `fileIdFilter`
 * for scoping queries by raw filename (e.g., by tag suffix). Kept out of the
 * public `Storage['runs']['list']` surface — consumers of `@workflow/world`
 * must not see this option.
 */
export interface LocalListWorkflowRunsParams extends ListWorkflowRunsParams {
  fileIdFilter?: (fileId: string) => boolean;
}

export interface LocalRunsStorage {
  get: Storage['runs']['get'];
  list: {
    (
      params: LocalListWorkflowRunsParams & { resolveData: 'none' }
    ): Promise<PaginatedResponse<WorkflowRunWithoutData>>;
    (
      params?: LocalListWorkflowRunsParams & { resolveData?: 'all' }
    ): Promise<PaginatedResponse<WorkflowRun>>;
    (
      params?: LocalListWorkflowRunsParams
    ): Promise<PaginatedResponse<WorkflowRun | WorkflowRunWithoutData>>;
  };
  experimentalSetAttributes(
    runId: string,
    changes: AttributeChange[]
  ): Promise<ExperimentalSetAttributesResult>;
}

/**
 * Per-run in-process async mutex. Serializes concurrent attribute writes
 * to the same run so the read-merge-write sequence is atomic. Without this
 * two parallel `setAttributes` calls (e.g. from `Promise.all` steps) can
 * both read the same prior snapshot and one of the updates is lost.
 */
const runAttributeLocks = new Map<string, Promise<unknown>>();

function withRunAttributeLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = runAttributeLocks.get(key);
  const taskBox: { task?: Promise<T> } = {};
  const task = (async () => {
    if (prev) await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      if (runAttributeLocks.get(key) === taskBox.task) {
        runAttributeLocks.delete(key);
      }
    }
  })();
  taskBox.task = task;
  runAttributeLocks.set(key, task);
  return task;
}

/**
 * Creates the runs storage implementation using the filesystem.
 * Implements the Storage['runs'] interface with get and list operations,
 * plus an internal `fileIdFilter` on `list` for tag-scoped recovery queries.
 */
export function createRunsStorage(
  basedir: string,
  tag?: string
): LocalRunsStorage {
  return {
    get: (async (id: string, params?: any) => {
      assertSafeEntityId('runId', id);
      const run = await readJSONWithFallback(
        basedir,
        'runs',
        id,
        WorkflowRunSchema,
        tag
      );
      if (!run) {
        throw new WorkflowRunNotFoundError(id);
      }
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterRunData(run, resolveData);
    }) as Storage['runs']['get'],

    list: (async (params?: LocalListWorkflowRunsParams) => {
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = await paginatedFileSystemQuery({
        directory: path.join(basedir, 'runs'),
        schema: WorkflowRunSchema,
        fileIdFilter: params?.fileIdFilter,
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

      // If resolveData is "none", replace input/output with undefined
      if (resolveData === 'none') {
        return {
          ...result,
          data: result.data.map((run) => ({
            ...run,
            input: undefined,
            output: undefined,
          })) as WorkflowRunWithoutData[],
        };
      }

      return result;
    }) as LocalRunsStorage['list'],

    experimentalSetAttributes: async (runId, changes) => {
      assertSafeEntityId('runId', runId);

      return withRunAttributeLock(runId, async () => {
        const run = await readJSONWithFallback(
          basedir,
          'runs',
          runId,
          WorkflowRunSchema,
          tag
        );
        if (!run) {
          throw new WorkflowRunNotFoundError(runId);
        }

        // Server-side validation. The SDK validates before sending, but
        // the world is the final authority — re-check so direct callers
        // (tests, other consumers) cannot bypass the limits.
        try {
          validateAttributeChanges(changes, {
            existingCount: Object.keys(run.attributes ?? {}).length,
          });
        } catch (err) {
          if (err instanceof AttributeValidationError) {
            // Re-throw as a plain error; callers (the SDK) wrap as
            // FatalError on their side.
            throw err;
          }
          throw err;
        }

        const nextAttributes = applyAttributeChanges(run.attributes, changes);
        const updatedRun = {
          ...run,
          attributes: nextAttributes,
          updatedAt: new Date(),
        };

        await writeJSON(taggedPath(basedir, 'runs', runId, tag), updatedRun, {
          overwrite: true,
        });

        return { attributes: nextAttributes };
      });
    },
  };
}
