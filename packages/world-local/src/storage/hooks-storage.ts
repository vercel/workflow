import { HookNotFoundError } from '@workflow/errors';
import type {
  GetHookParams,
  Hook,
  ListHooksParams,
  PaginatedResponse,
  Storage,
} from '@workflow/world';
import { isTerminalWorkflowRunStatus } from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import { decode } from '../db/codec.js';
import type { Database } from '../db/index.js';
import { assertSafeEntityId } from '../ids.js';
import { filterHookData } from './filters.js';
import { entityCursor, entityCursorClause, Store } from './store.js';

/**
 * Hook reads. A hook row exists while its hook is live, and past its run's
 * end while its token retention lasts; disposal deletes it. A retained hook
 * is readable until its retention ends, then reads as not found.
 */
export function createHooksStorage(
  db: Database,
  tag?: string
): Storage['hooks'] {
  const store = new Store(db, tag);

  function isAvailable(hook: Hook): boolean {
    if (store.getDisposal(hook.hookId)) return false;
    if (
      hook.tokenRetentionUntil &&
      new Date(hook.tokenRetentionUntil).getTime() > Date.now()
    ) {
      return true;
    }
    const run = store.getRunAnyTag(hook.runId);
    return run !== null && !isTerminalWorkflowRunStatus(run.run.status);
  }

  const withDefaults = (hook: Hook): Hook => ({
    ...hook,
    isWebhook: hook.isWebhook ?? true,
  });

  async function get(hookId: string, params?: GetHookParams): Promise<Hook> {
    assertSafeEntityId('hookId', hookId);
    const hook = store.getHook(hookId);
    if (!hook || !isAvailable(hook)) throw new HookNotFoundError(hookId);
    return filterHookData(
      withDefaults(hook),
      params?.resolveData || DEFAULT_RESOLVE_DATA_OPTION
    );
  }

  async function getByToken(token: string): Promise<Hook> {
    const owner = store.getTokenOwner(token);
    const hook = owner ? store.getHook(owner.hookId) : null;
    if (!hook || hook.token !== token || !isAvailable(hook)) {
      throw new HookNotFoundError(token);
    }
    return withDefaults(hook);
  }

  async function list(
    params: ListHooksParams
  ): Promise<PaginatedResponse<Hook>> {
    const resolveData = params.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
    const sortOrder: 'asc' | 'desc' = params.pagination?.sortOrder ?? 'asc';
    const limit = Math.max(1, params.pagination?.limit ?? 20);
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (params.runId) {
      clauses.push('run_id = ?');
      values.push(params.runId);
    }
    const cursor = entityCursorClause(
      params.pagination?.cursor,
      sortOrder,
      'created_at',
      'hook_id'
    );
    if (cursor) {
      clauses.push(cursor.sql);
      values.push(...cursor.params);
    }
    const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
    const data: Hook[] = [];
    let hasMore = false;
    // Availability depends on the clock and on other rows, so it is applied
    // after the query, a batch at a time, until a page is full.
    let offset = 0;
    const batch = Math.max(limit + 1, 100);
    while (true) {
      const rows = db.all<{ doc: string }>(
        `SELECT doc FROM hooks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY created_at ${direction}, hook_id ${direction} LIMIT ? OFFSET ?`,
        ...values,
        batch,
        offset
      );
      offset += rows.length;
      for (const row of rows) {
        const hook = decode<Hook>(row.doc);
        if (!isAvailable(hook)) continue;
        if (data.length === limit) {
          hasMore = true;
          break;
        }
        data.push(hook);
      }
      if (hasMore || rows.length < batch) break;
    }
    const last = data.at(-1);
    return {
      data: data.map((hook) => filterHookData(hook, resolveData)),
      cursor: last ? entityCursor(last.createdAt, last.hookId) : null,
      hasMore,
    };
  }

  return { get, getByToken, list };
}
