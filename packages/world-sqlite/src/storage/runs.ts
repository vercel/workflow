import { WorkflowRunNotFoundError } from '@workflow/errors';
import type {
  ListWorkflowRunsParams,
  Storage,
  WorkflowRun,
} from '@workflow/world';
import {
  applyAttributeChanges,
  isTerminalWorkflowRunStatus,
  validateAttributeChanges,
} from '@workflow/world';
import {
  assertSafeEntityId,
  type Ctx,
  createTimeCursor,
  DEFAULT_RESOLVE_DATA_OPTION,
  getRunStatusPollIntervalMs,
  parseRun,
  parseTimeCursor,
  readRun,
  waitForRunTerminalSignal,
  writeRun,
} from './common.js';
import { filterRunData } from './filters.js';

export function createRunsStorage(ctx: Ctx): Storage['runs'] {
  const { db } = ctx;

  const get = (async (id: string, params?: any) => {
    assertSafeEntityId('runId', id);
    const run = readRun(ctx, id);
    if (!run) {
      throw new WorkflowRunNotFoundError(id);
    }
    const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
    return filterRunData(run, resolveData);
  }) as Storage['runs']['get'];

  return {
    get,

    waitForTerminalStatus: (async (id: string, params?: any) => {
      const deadline = Date.now() + (params?.timeoutMs ?? 0);
      while (true) {
        const run = await get(id, params);
        if (isTerminalWorkflowRunStatus(run.status)) return run;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0 || params?.signal?.aborted) return run;
        // In-process transitions wake this immediately; another process's
        // are seen on the next poll.
        await waitForRunTerminalSignal(
          id,
          Math.min(remainingMs, getRunStatusPollIntervalMs()),
          params?.signal
        );
      }
    }) as NonNullable<Storage['runs']['waitForTerminalStatus']>,

    getMany: (async (ids: readonly string[], params?: any) => {
      const uniqueIds = [...new Set(ids)];
      const runs = await Promise.all(
        uniqueIds.map(async (id) => {
          try {
            return await get(id, params);
          } catch (error) {
            if (error instanceof WorkflowRunNotFoundError) return null;
            throw error;
          }
        })
      );
      const runById = new Map(uniqueIds.map((id, i) => [id, runs[i]]));
      return ids.map((id) => runById.get(id) ?? null);
    }) as NonNullable<Storage['runs']['getMany']>,

    list: (async (
      params?: ListWorkflowRunsParams & { ownTagOnly?: boolean }
    ) => {
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const where: string[] = [];
      const args: string[] = [];
      if (params?.ownTagOnly) {
        // Recovery only re-enqueues this instance's own runs.
        where.push('tag = ?');
        args.push(ctx.tag);
      }
      if (params?.workflowName) {
        where.push('workflow_name = ?');
        args.push(params.workflowName);
      }
      if (params?.status !== undefined) {
        const statuses = Array.isArray(params.status)
          ? params.status
          : [params.status];
        where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        args.push(...statuses);
      }
      // Keyset pagination on (created_at, run_id), the order world-local
      // sorts in. Every tag's runs are listed, like its directory listing.
      const sortOrder = params?.pagination?.sortOrder ?? 'desc';
      const limit = params?.pagination?.limit ?? 200;
      const cursor = parseTimeCursor(params?.pagination?.cursor);
      const cmp = sortOrder === 'desc' ? '<' : '>';
      const bind: (string | number)[] = [...args];
      if (cursor) {
        const t = cursor.timestamp.getTime();
        if (cursor.id) {
          where.push(
            `(created_at ${cmp} ? OR (created_at = ? AND run_id ${cmp} ?))`
          );
          bind.push(t, t, cursor.id);
        } else {
          where.push(`created_at ${cmp} ?`);
          bind.push(t);
        }
      }
      const dir = sortOrder === 'desc' ? 'DESC' : 'ASC';
      const rows = db.all<{ data: Uint8Array }>(
        `SELECT data FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at ${dir}, run_id ${dir} LIMIT ?`,
        ...bind,
        limit + 1
      );
      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit).map((row) => parseRun(row.data));
      const last = data.at(-1);
      const result = {
        data,
        cursor: last ? createTimeCursor(last.createdAt, last.runId) : null,
        hasMore,
      };
      if (resolveData === 'none') {
        return {
          ...result,
          data: result.data.map((run) => filterRunData(run, 'none')),
        };
      }
      return result;
    }) as Storage['runs']['list'],

    experimentalSetAttributes: async (runId, changes, options) => {
      assertSafeEntityId('runId', runId);
      return db.transaction(() => {
        const run = readRun(ctx, runId);
        if (!run) {
          throw new WorkflowRunNotFoundError(runId);
        }
        validateAttributeChanges(changes, {
          existingKeys: Object.keys(run.attributes ?? {}),
          allowReservedAttributes: options?.allowReservedAttributes,
        });
        const nextAttributes = applyAttributeChanges(run.attributes, changes);
        writeRun(ctx, {
          ...run,
          attributes: nextAttributes,
          updatedAt: new Date(),
        } as WorkflowRun);
        return { attributes: nextAttributes };
      });
    },
  } as Storage['runs'];
}
