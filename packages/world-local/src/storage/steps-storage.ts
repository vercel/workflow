import type { Step, StepWithoutData, Storage } from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import { decode } from '../db/codec.js';
import type { Database } from '../db/index.js';
import { assertSafeEntityId } from '../ids.js';
import { filterStepData } from './filters.js';
import { entityCursor, entityCursorClause, Store } from './store.js';

export function createStepsStorage(
  db: Database,
  tag?: string
): Storage['steps'] {
  const store = new Store(db, tag);
  return {
    get: (async (runId: string, stepId: string, params?: any) => {
      assertSafeEntityId('runId', runId);
      assertSafeEntityId('stepId', stepId);
      const step = store.getStep(runId, stepId);
      if (!step) {
        throw new Error(`Step ${stepId} in run ${runId} not found`);
      }
      return filterStepData(
        step,
        params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION
      );
    }) as Storage['steps']['get'],

    list: (async (params: any) => {
      assertSafeEntityId('runId', params.runId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const sortOrder: 'asc' | 'desc' = params.pagination?.sortOrder ?? 'desc';
      const limit = Math.max(1, params.pagination?.limit ?? 20);
      const clauses = ['run_id = ?'];
      const values: unknown[] = [params.runId];
      const cursor = entityCursorClause(
        params.pagination?.cursor,
        sortOrder,
        'created_at',
        'step_id'
      );
      if (cursor) {
        clauses.push(cursor.sql);
        values.push(...cursor.params);
      }
      const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
      const rows = db.all<{ doc: string }>(
        `SELECT doc FROM steps WHERE ${clauses.join(' AND ')}
         ORDER BY created_at ${direction}, step_id ${direction} LIMIT ?`,
        ...values,
        limit + 1
      );
      const hasMore = rows.length > limit;
      const data = (hasMore ? rows.slice(0, limit) : rows).map((row) =>
        decode<Step>(row.doc)
      );
      const last = data.at(-1);
      return {
        data:
          resolveData === 'none'
            ? (data.map((step) =>
                filterStepData(step, 'none')
              ) as StepWithoutData[])
            : data,
        cursor: last ? entityCursor(last.createdAt, last.stepId) : null,
        hasMore,
      };
    }) as Storage['steps']['list'],
  };
}
