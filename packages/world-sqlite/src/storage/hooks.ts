import { HookNotFoundError } from '@workflow/errors';
import type {
  GetHookParams,
  Hook,
  ListHooksParams,
  PaginatedResponse,
  Storage,
} from '@workflow/world';
import { isTerminalWorkflowRunStatus } from '@workflow/world';
import {
  assertSafeEntityId,
  type Ctx,
  DEFAULT_RESOLVE_DATA_OPTION,
  isHookDisposalCommitted,
  paginateByCreatedAt,
  parseHook,
  readHook,
  readHookDisposeLock,
  readHookTokenClaim,
  readRun,
} from './common.js';
import { filterHookData } from './filters.js';

export function createHooksStorage(ctx: Ctx): Storage['hooks'] {
  const { db } = ctx;

  function isTerminalRun(runId: string): boolean {
    const run = readRun(ctx, runId);
    return run ? isTerminalWorkflowRunStatus(run.status) : false;
  }

  /**
   * Live: not disposed, and its run still running, or finished but still
   * inside the hook's token retention.
   */
  function isHookAvailable(hook: Hook): boolean {
    if (isHookDisposalCommitted(ctx, hook.hookId)) return false;
    if (
      hook.tokenRetentionUntil &&
      hook.tokenRetentionUntil.getTime() > Date.now()
    ) {
      return true;
    }
    return !isTerminalRun(hook.runId);
  }

  function isForceDisposed(hook: Hook): boolean {
    const lock = readHookDisposeLock(ctx, hook.hookId);
    return lock.committed && lock.forceClaimedBy !== undefined;
  }

  function findHookByToken(token: string): Hook | null {
    // Fast path: the token's claim names its owner.
    const claim = readHookTokenClaim(ctx, token);
    if (claim?.hookId) {
      const hook = readHook(ctx, claim.hookId);
      if (hook?.token === token) {
        if (isHookAvailable(hook)) {
          return { ...hook, isWebhook: hook.isWebhook ?? true };
        }
        if (!isForceDisposed(hook)) {
          throw new HookNotFoundError(token);
        }
      } else if (hook) {
        return null;
      }
    }

    // Every hook holding the token. A force-claim victim sits beside its
    // claimer; only a live one answers, and a closed one doesn't end the
    // search.
    let disposedMatch = false;
    for (const row of db.all<{ data: Uint8Array }>(
      "SELECT data FROM hooks WHERE token = ? AND tag IN (?, '') ORDER BY hook_id, tag = ''",
      token,
      ctx.tag
    )) {
      const hook = parseHook(row.data);
      if (isHookAvailable(hook)) {
        return { ...hook, isWebhook: hook.isWebhook ?? true };
      }
      if (isForceDisposed(hook)) {
        disposedMatch = true;
        continue;
      }
      throw new HookNotFoundError(token);
    }
    if (disposedMatch) {
      throw new HookNotFoundError(token);
    }
    return null;
  }

  async function get(hookId: string, params?: GetHookParams): Promise<Hook> {
    assertSafeEntityId('hookId', hookId);
    const stored = readHook(ctx, hookId);
    if (!stored || !isHookAvailable(stored)) {
      throw new HookNotFoundError(hookId);
    }
    const resolveData = params?.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
    return filterHookData(
      { ...stored, isWebhook: stored.isWebhook ?? true },
      resolveData
    );
  }

  async function getByToken(token: string): Promise<Hook> {
    const hook = findHookByToken(token);
    if (!hook) {
      throw new HookNotFoundError(token);
    }
    return hook;
  }

  async function list(
    params: ListHooksParams
  ): Promise<PaginatedResponse<Hook>> {
    const resolveData = params.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
    const rows = params.runId
      ? db.all<{ data: Uint8Array }>(
          'SELECT data FROM hooks WHERE run_id = ?',
          params.runId
        )
      : db.all<{ data: Uint8Array }>('SELECT data FROM hooks');
    const hooks = rows
      .map((row) => parseHook(row.data))
      .filter(
        (hook) =>
          (!params.runId || hook.runId === params.runId) &&
          isHookAvailable(hook)
      );
    const result = paginateByCreatedAt(hooks, {
      getCreatedAt: (hook) => hook.createdAt,
      getId: (hook) => hook.hookId,
      sortOrder: params.pagination?.sortOrder ?? 'asc',
      limit: params.pagination?.limit,
      cursor: params.pagination?.cursor,
    });
    return {
      ...result,
      data: result.data.map((hook) => filterHookData(hook, resolveData)),
    };
  }

  return { get, getByToken, list };
}
