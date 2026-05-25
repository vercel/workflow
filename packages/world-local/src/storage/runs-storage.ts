import path from 'node:path';
import { WorkflowRunNotFoundError } from '@workflow/errors';
import type {
  ListWorkflowRunsParams,
  PaginatedResponse,
  Storage,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import { WorkflowRunSchema } from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  assertSafeEntityId,
  paginatedFileSystemQuery,
  readJSONWithFallback,
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
  };
}
