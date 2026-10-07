import path from 'node:path';
import type { StepWithoutData, Storage } from '@workflow/world';
import { StepSchema } from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  assertSafeEntityId,
  paginatedFileSystemQuery,
  readJSONWithFallback,
  runEntityDir,
} from '../fs.js';
import { filterStepData } from './filters.js';
import { getObjectCreatedAt } from './helpers.js';

/**
 * Creates the steps storage implementation using the filesystem.
 * Implements the Storage['steps'] interface with get and list operations.
 */
export function createStepsStorage(
  basedir: string,
  tag?: string
): Storage['steps'] {
  return {
    get: (async (runId: string, stepId: string, params?: any) => {
      assertSafeEntityId('runId', runId);
      assertSafeEntityId('stepId', stepId);
      const compositeKey = `${runId}-${stepId}`;
      const step = await readJSONWithFallback(
        basedir,
        runEntityDir('steps', runId),
        compositeKey,
        StepSchema,
        tag
      );
      if (!step) {
        throw new Error(`Step ${stepId} in run ${runId} not found`);
      }
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterStepData(step, resolveData);
    }) as Storage['steps']['get'],

    list: (async (params: any) => {
      assertSafeEntityId('runId', params.runId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = await paginatedFileSystemQuery({
        directory: path.join(basedir, runEntityDir('steps', params.runId)),
        schema: StepSchema,
        filePrefix: `${params.runId}-`,
        sortOrder: params.pagination?.sortOrder ?? 'desc',
        limit: params.pagination?.limit,
        cursor: params.pagination?.cursor,
        getCreatedAt: getObjectCreatedAt('step'),
        getId: (step) => step.stepId,
      });

      // If resolveData is "none", replace input/output with undefined
      if (resolveData === 'none') {
        return {
          ...result,
          data: result.data.map((step) => ({
            ...step,
            input: undefined,
            output: undefined,
          })) as StepWithoutData[],
        };
      }

      return result;
    }) as Storage['steps']['list'],
  };
}
