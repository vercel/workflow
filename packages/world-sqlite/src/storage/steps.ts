import type { Storage } from '@workflow/world';
import {
  assertSafeEntityId,
  type Ctx,
  DEFAULT_RESOLVE_DATA_OPTION,
  listStepRows,
  paginateByCreatedAt,
  readStep,
} from './common.js';
import { filterStepData } from './filters.js';

export function createStepsStorage(ctx: Ctx): Storage['steps'] {
  return {
    get: (async (runId: string, stepId: string, params?: any) => {
      assertSafeEntityId('runId', runId);
      assertSafeEntityId('stepId', stepId);
      const step = readStep(ctx, runId, stepId);
      if (!step) {
        throw new Error(`Step ${stepId} in run ${runId} not found`);
      }
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return filterStepData(step, resolveData);
    }) as Storage['steps']['get'],

    list: (async (params: any) => {
      assertSafeEntityId('runId', params.runId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = paginateByCreatedAt(
        listStepRows(ctx, params.runId).map((row) => row.step),
        {
          getCreatedAt: (step) => step.createdAt,
          getId: (step) => step.stepId,
          sortOrder: params.pagination?.sortOrder ?? 'desc',
          limit: params.pagination?.limit,
          cursor: params.pagination?.cursor,
        }
      );
      if (resolveData === 'none') {
        return {
          ...result,
          data: result.data.map((step) => ({
            ...step,
            input: undefined,
            output: undefined,
          })),
        };
      }
      return result;
    }) as Storage['steps']['list'],
  };
}
