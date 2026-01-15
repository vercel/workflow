import path from 'node:path';
import type { Step, Storage } from '@workflow/world';
import { StepSchema } from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import { listJSONFiles, paginatedFileSystemQuery, readJSON } from '../fs.js';
import { filterStepData } from './filters.js';
import { getObjectCreatedAt } from './helpers.js';

/**
 * Creates the steps storage implementation using the filesystem.
 * Implements the Storage['steps'] interface with get and list operations.
 */
export function createStepsStorage(basedir: string): Storage['steps'] {
  return {
    async get(
      runId: string | undefined,
      stepId: string,
      params
    ): Promise<Step> {
      if (!runId) {
        const fileIds = await listJSONFiles(path.join(basedir, 'steps'));
        const fileId = fileIds.find((fileId) => fileId.endsWith(`-${stepId}`));
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
  };
}
