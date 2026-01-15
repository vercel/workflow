import path from 'node:path';
import { WorkflowRunNotFoundError } from '@workflow/errors';
import type { Storage } from '@workflow/world';
import { WorkflowRunSchema } from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import { paginatedFileSystemQuery, readJSON } from '../fs.js';
import { filterRunData } from './filters.js';
import { getObjectCreatedAt } from './helpers.js';

/**
 * Creates the runs storage implementation using the filesystem.
 * Implements the Storage['runs'] interface with get and list operations.
 */
export function createRunsStorage(basedir: string): Storage['runs'] {
  return {
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
  };
}
