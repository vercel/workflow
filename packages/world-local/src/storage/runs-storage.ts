import { WorkflowRunNotFoundError } from '@workflow/errors';
import type {
  AttributeChange,
  DeleteRunDataResult,
  DeleteRunsDataRequest,
  DeleteRunsDataResult,
  ExperimentalSetAttributesResult,
  ListWorkflowRunsParams,
  PaginatedResponse,
  Storage,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  applyAttributeChanges,
  DeleteRunsDataRequestSchema,
  isTerminalWorkflowRunStatus,
  validateAttributeChanges,
} from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import { decode } from '../db/codec.js';
import type { Database } from '../db/index.js';
import { assertSafeEntityId } from '../ids.js';
import { withRunPayloadsPurged } from './events-storage.js';
import { filterRunData } from './filters.js';
import { purgeRunData } from './run-retention.js';
import {
  RUN_STATUS_POLL_INTERVAL_MS,
  waitForRunTerminalSignal,
} from './run-status-signal.js';
import {
  entityCursor,
  entityCursorClause,
  Store,
  tagClause,
  tagParams,
} from './store.js';

/**
 * Internal extension of `ListWorkflowRunsParams`: `ownTagOnly` scopes a
 * listing to this World's tag (untagged rows for an untagged World), which
 * startup recovery uses so a dev server never recovers a test's runs. Kept
 * out of the public `Storage['runs']['list']` surface.
 */
export interface LocalListWorkflowRunsParams extends ListWorkflowRunsParams {
  ownTagOnly?: boolean;
}

export interface LocalRunsStorage {
  get: Storage['runs']['get'];
  waitForTerminalStatus: NonNullable<Storage['runs']['waitForTerminalStatus']>;
  getMany: NonNullable<Storage['runs']['getMany']>;
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
    changes: AttributeChange[],
    options?: { allowReservedAttributes?: boolean }
  ): Promise<ExperimentalSetAttributesResult>;
  deleteDataMany: NonNullable<Storage['runs']['deleteDataMany']>;
}

export function createRunsStorage(
  db: Database,
  tag?: string
): LocalRunsStorage {
  const store = new Store(db, tag);

  const get = (async (id: string, params?: any) => {
    assertSafeEntityId('runId', id);
    const row = store.getRun(id);
    if (!row) throw new WorkflowRunNotFoundError(id);
    return filterRunData(
      row.run,
      params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION
    );
  }) as Storage['runs']['get'];

  /**
   * Delete one finished run's data, as a zero-retention run's is deleted when
   * it finishes: its own payloads and its `expiredAt` boundary, and its
   * steps', events', hooks' and streams' payloads, in one transaction. A run
   * that has not finished is left untouched.
   */
  function deleteRunData(runId: string): DeleteRunDataResult {
    const row = store.getRun(runId);
    if (!row) return { runId, outcome: 'not_found' };
    const { run } = row;
    if (!isTerminalWorkflowRunStatus(run.status)) {
      return {
        runId,
        outcome: 'skipped',
        reason: 'run_not_terminal',
        status: run.status,
      };
    }
    const now = new Date();
    const alreadyDeleted =
      run.expiredAt !== undefined && run.expiredAt.getTime() <= now.getTime();
    // An already deleted run keeps its first `expiredAt`; anything an
    // earlier pass left behind is scrubbed again either way.
    if (!alreadyDeleted) store.updateRun(withRunPayloadsPurged(run, now));
    purgeRunData(db, runId);
    return { runId, outcome: alreadyDeleted ? 'already_deleted' : 'deleted' };
  }

  return {
    get,

    /**
     * Long poll for a terminal status: reads the run, and while it is not
     * terminal waits for an in-process terminal signal or the short backstop
     * interval (a write from another process signals nothing here).
     */
    waitForTerminalStatus: (async (id: string, params?: any) => {
      const deadline = Date.now() + (params?.timeoutMs ?? 0);
      while (true) {
        const run = await get(id, params);
        if (isTerminalWorkflowRunStatus(run.status)) return run;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0 || params?.signal?.aborted) return run;
        await waitForRunTerminalSignal(
          id,
          Math.min(remainingMs, RUN_STATUS_POLL_INTERVAL_MS),
          params?.signal
        );
      }
    }) as NonNullable<Storage['runs']['waitForTerminalStatus']>,

    getMany: (async (ids: readonly string[], params?: any) => {
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return ids.map((id) => {
        const row = store.getRun(id);
        return row ? filterRunData(row.run, resolveData) : null;
      });
    }) as NonNullable<Storage['runs']['getMany']>,

    list: (async (params?: LocalListWorkflowRunsParams) => {
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const sortOrder = params?.pagination?.sortOrder ?? 'desc';
      const limit = Math.max(1, params?.pagination?.limit ?? 200);
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (params?.ownTagOnly) {
        if (tag === undefined) {
          clauses.push('tag IS NULL');
        } else {
          clauses.push('tag = ?');
          values.push(tag);
        }
      }
      if (params?.workflowName) {
        clauses.push('workflow_name = ?');
        values.push(params.workflowName);
      }
      if (params?.status !== undefined) {
        const statuses = Array.isArray(params.status)
          ? params.status
          : [params.status];
        // An empty array matches no runs (SQL `IN ()`, as world-postgres).
        if (statuses.length === 0) {
          return { data: [], cursor: null, hasMore: false };
        }
        clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        values.push(...statuses);
      }
      const cursor = entityCursorClause(
        params?.pagination?.cursor,
        sortOrder,
        'created_at',
        'run_id'
      );
      if (cursor) {
        clauses.push(cursor.sql);
        values.push(...cursor.params);
      }
      const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
      const rows = db.all<{ doc: string }>(
        `SELECT doc FROM runs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY created_at ${direction}, run_id ${direction} LIMIT ?`,
        ...values,
        limit + 1
      );
      const hasMore = rows.length > limit;
      const data = (hasMore ? rows.slice(0, limit) : rows).map((row) =>
        decode<WorkflowRun>(row.doc)
      );
      const last = data.at(-1);
      return {
        data: data.map((run) => filterRunData(run, resolveData)),
        cursor: last ? entityCursor(last.createdAt, last.runId) : null,
        hasMore,
      };
    }) as LocalRunsStorage['list'],

    experimentalSetAttributes: async (runId, changes, options) => {
      assertSafeEntityId('runId', runId);
      return db.transactAsync(() => {
        const row = store.getRun(runId);
        if (!row) throw new WorkflowRunNotFoundError(runId);
        // The SDK validates before sending, but the World is the final
        // authority.
        validateAttributeChanges(changes, {
          existingKeys: Object.keys(row.run.attributes ?? {}),
          allowReservedAttributes: options?.allowReservedAttributes,
        });
        const attributes = applyAttributeChanges(row.run.attributes, changes);
        store.updateRun({ ...row.run, attributes, updatedAt: new Date() });
        return { attributes };
      });
    },

    /**
     * Delete the data of many finished runs. See
     * `Storage['runs'].deleteDataMany`.
     */
    deleteDataMany: async (
      request: DeleteRunsDataRequest
    ): Promise<DeleteRunsDataResult> => {
      const { runIds } = DeleteRunsDataRequestSchema.parse(request);
      const results: DeleteRunDataResult[] = [];
      for (const runId of runIds) {
        try {
          assertSafeEntityId('runId', runId);
        } catch {
          // No run is ever stored under an unsafe ID.
          results.push({ runId, outcome: 'not_found' });
          continue;
        }
        try {
          results.push(await db.transactAsync(() => deleteRunData(runId)));
        } catch (error) {
          console.error(
            `[world-local] Failed to delete the data of run "${runId}":`,
            error
          );
          results.push({
            runId,
            outcome: 'failed',
            code: 'internal_error',
            retryable: true,
          });
        }
      }
      // The scrubbed bytes are still in the WAL until it is checkpointed.
      if (
        results.some(
          (r) => r.outcome === 'deleted' || r.outcome === 'already_deleted'
        )
      ) {
        db.checkpoint();
      }
      const count = (outcome: DeleteRunDataResult['outcome']) =>
        results.filter((result) => result.outcome === outcome).length;
      return {
        summary: {
          requested: runIds.length,
          deleted: count('deleted'),
          alreadyDeleted: count('already_deleted'),
          skipped: count('skipped'),
          notCreated: count('not_created'),
          notFound: count('not_found'),
          failed: count('failed'),
        },
        results,
      };
    },
  };
}

export { tagClause, tagParams };
