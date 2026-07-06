import path from 'node:path';
import { HookNotFoundError } from '@workflow/errors';
import type {
  Event,
  GetHookParams,
  Hook,
  HookCreatedEvent,
  ListHooksParams,
  PaginatedResponse,
  Storage,
} from '@workflow/world';
import {
  EventSchema,
  HookSchema,
  isTerminalRunEventType,
  isTerminalWorkflowRunStatus,
  WorkflowRunSchema,
} from '@workflow/world';
import { z } from 'zod';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  assertSafeEntityId,
  deleteJSON,
  hasTag,
  isUntagged,
  jsonReplacer,
  listJSONFiles,
  paginatedFileSystemQuery,
  readJSON,
  readJSONWithFallback,
  taggedPath,
  writeExclusive,
  writeJSON,
} from '../fs.js';
import { filterHookData } from './filters.js';
import {
  canReuseExpiredStartClaim,
  type HookTokenClaim,
  hookRecoveryMarkerPath,
  hookTokenClaimPath,
  readHookTokenClaim,
  withTokenClaimLock,
} from './helpers.js';

/**
 * Transitions a TTL-carrying claim to retained: the token stays fenced
 * until at least `hookCreatedAt + ttl` (falling back to the claim's own
 * createdAt when no hook was ever created), never shrinking an existing
 * retention window and never expiring before `now`.
 */
async function retainStartHookClaim(
  constraintPath: string,
  claim: HookTokenClaim,
  now: Date,
  hookCreatedAt?: Date
): Promise<void> {
  if (!claim.ttlSeconds) return;

  const ttlBase = hookCreatedAt ?? claim.createdAt ?? now;
  const expiresAt = new Date(
    Math.max(
      ttlBase.getTime() + claim.ttlSeconds * 1000,
      claim.expiresAt?.getTime() ?? 0,
      now.getTime()
    )
  );

  await writeJSON(constraintPath, { ...claim, expiresAt }, { overwrite: true });
}

/**
 * Settles a disposed hook's token claim: TTL-carrying claims are retained
 * (duplicate starts stay fenced past disposal), plain createHook guards are
 * deleted to free the token. Shared by hook_disposed and terminal-run
 * cleanup.
 */
export async function settleClaimForDisposedHook(
  basedir: string,
  hook: Pick<Hook, 'token' | 'runId' | 'createdAt'>,
  now: Date
): Promise<string> {
  const constraintPath = hookTokenClaimPath(basedir, hook.token);
  // Settle under the claim lock and re-validate ownership: once a run is
  // terminal, its expired claim becomes reclaimable, so an unguarded
  // read-then-write here could clobber a fresh claim a new run just
  // installed. Claims owned by another run are left alone. A contended
  // lock skips the settle — the claim then expires via its
  // createdAt + ttl fallback instead of the hookCreatedAt + ttl anchor.
  // Bounded retry: a briefly contended lock must not skip the settle (a
  // skipped plain-guard delete would fence the token until the owning run
  // ends). If all attempts stay contended, canReuseExpiredStartClaim's
  // run-liveness rule self-heals the leak once the owner is terminal.
  for (let attempt = 0; attempt < 3; attempt++) {
    const settled = await withTokenClaimLock(basedir, hook.token, async () => {
      const claim = await readHookTokenClaim(constraintPath);
      if (!claim || claim.runId !== hook.runId) return true;
      if (claim.ttlSeconds) {
        await retainStartHookClaim(
          constraintPath,
          { ...claim, token: hook.token },
          now,
          hook.createdAt
        );
      } else {
        await deleteJSON(constraintPath);
      }
      return true;
    });
    if (settled) break;
    await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
  }
  return constraintPath;
}

/**
 * Re-reads a token claim under its lock and acts only when `revalidate`
 * still holds — the shared lock + re-validation discipline for claim writes
 * (see settleClaimForDisposedHook). A contended lock skips the best-effort
 * operation.
 */
async function withRevalidatedClaim(
  basedir: string,
  token: string,
  constraintPath: string,
  revalidate: (latest: HookTokenClaim) => boolean | Promise<boolean>,
  act: (latest: HookTokenClaim) => Promise<void>
): Promise<void> {
  await withTokenClaimLock(basedir, token, async () => {
    const latest = await readHookTokenClaim(constraintPath);
    if (latest && (await revalidate(latest))) {
      await act(latest);
    }
  });
}

function isVisibleToTag(fileId: string, tag: string | undefined): boolean {
  return tag ? isUntagged(fileId) || hasTag(fileId, tag) : isUntagged(fileId);
}

function getHookCreatedToken(event: Event): string | undefined {
  if (event.eventType !== 'hook_created') return undefined;
  const token = (event.eventData as { token?: unknown }).token;
  return typeof token === 'string' ? token : undefined;
}

function hookFromCreatedEvent(event: Event & HookCreatedEvent): Hook {
  const { token, metadata, isWebhook, isSystem } = event.eventData;
  return {
    runId: event.runId,
    hookId: event.correlationId,
    token,
    metadata,
    ownerId: 'local-owner',
    projectId: 'local-project',
    environment: 'local',
    createdAt: event.createdAt,
    specVersion: event.specVersion,
    isWebhook: isWebhook ?? true,
    isSystem: isSystem ?? false,
  };
}

function isMatchingHookCreatedEvent(
  event: Event,
  matches: (event: Event) => boolean
): event is Event & HookCreatedEvent {
  return (
    event.eventType === 'hook_created' &&
    typeof event.correlationId === 'string' &&
    matches(event)
  );
}

function closesLiveHook(
  event: Event,
  liveEvent: Event & HookCreatedEvent
): boolean {
  if (event.runId !== liveEvent.runId) return false;
  return (
    (event.eventType === 'hook_disposed' &&
      event.correlationId === liveEvent.correlationId) ||
    isTerminalRunEventType(event.eventType)
  );
}

async function readEventForHookScan(filePath: string): Promise<Event | null> {
  try {
    return await readJSON(filePath, EventSchema);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return null;
    }
    throw error;
  }
}

async function isTerminalRunCache(
  basedir: string,
  runId: string,
  tag?: string
): Promise<boolean> {
  const run = await readJSONWithFallback(
    basedir,
    'runs',
    runId,
    WorkflowRunSchema,
    tag
  );
  return run ? isTerminalWorkflowRunStatus(run.status) : false;
}

async function findLiveHookCreatedEvent(
  basedir: string,
  matches: (event: Event) => boolean,
  tag?: string
): Promise<(Event & HookCreatedEvent) | null> {
  const eventsDir = path.join(basedir, 'events');
  const events: Event[] = [];

  for (const fileId of await listJSONFiles(eventsDir)) {
    if (!isVisibleToTag(fileId, tag)) continue;
    const event = await readEventForHookScan(
      path.join(eventsDir, `${fileId}.json`)
    );
    if (event) events.push(event);
  }

  events.sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    return byTime === 0 ? a.eventId.localeCompare(b.eventId) : byTime;
  });

  let liveEvent: (Event & HookCreatedEvent) | null = null;
  for (const event of events) {
    if (isMatchingHookCreatedEvent(event, matches)) {
      liveEvent = event;
      continue;
    }

    if (liveEvent && closesLiveHook(event, liveEvent)) {
      liveEvent = null;
    }
  }

  if (liveEvent && (await isTerminalRunCache(basedir, liveEvent.runId, tag))) {
    return null;
  }

  return liveEvent;
}

async function restoreHookCachesFromEvent(
  basedir: string,
  event: Event & HookCreatedEvent,
  tag?: string
): Promise<Hook> {
  const hook = hookFromCreatedEvent(event);

  const claimPath = hookTokenClaimPath(basedir, hook.token);
  await writeExclusive(
    claimPath,
    JSON.stringify({
      token: hook.token,
      hookId: hook.hookId,
      runId: hook.runId,
      eventId: event.eventId,
      // Persisted so claim-liveness checks resolve the owning run in the
      // right namespace (see canReuseExpiredStartClaim).
      tag,
    })
  );
  await writeExclusive(
    taggedPath(basedir, 'hooks', hook.hookId, tag),
    JSON.stringify(hook, jsonReplacer, 2)
  );

  return hook;
}

export async function rebuildLiveHookByTokenFromEventLog(
  basedir: string,
  token: string,
  tag?: string
): Promise<Hook | null> {
  const event = await findLiveHookCreatedEvent(
    basedir,
    (candidate) => getHookCreatedToken(candidate) === token,
    tag
  );
  return event ? restoreHookCachesFromEvent(basedir, event, tag) : null;
}

async function rebuildLiveHookByIdFromEventLog(
  basedir: string,
  hookId: string,
  tag?: string
): Promise<Hook | null> {
  const event = await findLiveHookCreatedEvent(
    basedir,
    (candidate) => candidate.correlationId === hookId,
    tag
  );
  return event ? restoreHookCachesFromEvent(basedir, event, tag) : null;
}

/**
 * Creates a hooks storage implementation using the filesystem.
 * Implements the Storage['hooks'] interface with hook CRUD operations.
 */
export function createHooksStorage(
  basedir: string,
  tag?: string
): Storage['hooks'] {
  // Helper function to find a hook by token (shared between getByToken)
  async function findHookByToken(token: string): Promise<Hook | null> {
    const hooksDir = path.join(basedir, 'hooks');
    const files = await listJSONFiles(hooksDir);

    for (const file of files) {
      const hookPath = path.join(hooksDir, `${file}.json`);
      const hook = await readJSON(hookPath, HookSchema);
      if (hook && hook.token === token) {
        return { ...hook, isWebhook: hook.isWebhook ?? true };
      }
    }

    return null;
  }

  async function get(hookId: string, params?: GetHookParams): Promise<Hook> {
    assertSafeEntityId('hookId', hookId);
    const hook = await readJSONWithFallback(
      basedir,
      'hooks',
      hookId,
      HookSchema,
      tag
    );
    if (!hook) {
      const rebuilt = await rebuildLiveHookByIdFromEventLog(
        basedir,
        hookId,
        tag
      );
      if (!rebuilt) {
        throw new HookNotFoundError(hookId);
      }
      const resolveData = params?.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
      return filterHookData(
        { ...rebuilt, isWebhook: rebuilt.isWebhook ?? true },
        resolveData
      );
    }
    const resolveData = params?.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
    return filterHookData(
      { ...hook, isWebhook: hook.isWebhook ?? true },
      resolveData
    );
  }

  async function getByToken(token: string): Promise<Hook> {
    const hook =
      (await findHookByToken(token)) ??
      (await rebuildLiveHookByTokenFromEventLog(basedir, token, tag));
    if (!hook) {
      throw new HookNotFoundError(token);
    }
    return hook;
  }

  async function list(
    params: ListHooksParams
  ): Promise<PaginatedResponse<Hook>> {
    const hooksDir = path.join(basedir, 'hooks');
    const resolveData = params.resolveData || DEFAULT_RESOLVE_DATA_OPTION;

    const result = await paginatedFileSystemQuery({
      directory: hooksDir,
      schema: HookSchema,
      sortOrder: params.pagination?.sortOrder ?? 'asc',
      limit: params.pagination?.limit,
      cursor: params.pagination?.cursor,
      filePrefix: undefined, // Hooks don't have ULIDs, so we can't optimize by filename
      filter: (hook) => {
        // Filter by runId if provided
        if (params.runId && hook.runId !== params.runId) {
          return false;
        }
        return true;
      },
      getCreatedAt: () => {
        // Hook files don't have ULID timestamps in filename, so return null
        // to skip the filename-based optimization and defer to JSON-based
        // cursor filtering which uses the actual createdAt from the file.
        return null;
      },
      getId: (hook) => hook.hookId,
    });

    // Transform the data after pagination
    return {
      ...result,
      data: result.data.map((hook) => filterHookData(hook, resolveData)),
    };
  }

  return { get, getByToken, list };
}

/**
 * Helper function to delete all hooks associated with a workflow run.
 * Called when a run reaches a terminal state.
 *
 * `releaseUnmaterializedClaims` (used for cancellation) additionally deletes
 * start-hook claims the workflow never materialized into a hook, so
 * cancel-then-retry — including `start()`'s own cleanup when queueing fails
 * after admission — can reuse the token immediately.
 */
export async function deleteAllHooksForRun(
  basedir: string,
  runId: string,
  opts?: { releaseUnmaterializedClaims?: boolean; tag?: string }
): Promise<void> {
  const hooksDir = path.join(basedir, 'hooks');
  const files = await listJSONFiles(hooksDir);
  const tokensDir = path.join(hooksDir, 'tokens');
  const now = new Date();

  // Settle claims through the run's hook entities (retain TTL claims, free
  // plain guards), and delete the hooks + recovery markers. The marker's
  // filename hash includes `(token, runId, hookId)` so a leaked marker can
  // never corrupt a different lifetime — cleaning it up here keeps the
  // tokens/ directory from accumulating recovered-hook sidecars over time.
  const settledClaimPaths = new Set<string>();
  for (const file of files) {
    const hookPath = path.join(hooksDir, `${file}.json`);
    const hook = await readJSON(hookPath, HookSchema);
    if (hook && hook.runId === runId) {
      settledClaimPaths.add(
        await settleClaimForDisposedHook(basedir, hook, now)
      );
      await deleteJSON(
        hookRecoveryMarkerPath(basedir, hook.token, hook.runId, hook.hookId)
      );
      await deleteJSON(hookPath);
    }
  }

  // Sweep the tokens directory for claims with no hook entity: this run's
  // unmaterialized start claims (retain or, on cancellation, release), plus
  // opportunistic GC of other runs' dead claims so the directory doesn't
  // grow forever.
  const tokenFiles = await listJSONFiles(tokensDir);
  await Promise.all(
    tokenFiles.map(async (file) => {
      if (file.endsWith('.recovery')) return;
      const constraintPath = path.join(tokensDir, `${file}.json`);
      if (settledClaimPaths.has(constraintPath)) return;
      const claim = await readHookTokenClaim(constraintPath);
      if (!claim) return;
      if (claim.runId !== runId) {
        // A foreign claim with no retention window is settled by its own
        // run's termination (and self-heals via lazy claim-time reclaim if
        // that sweep was skipped) — checking it here would cost a run read
        // per foreign plain guard on every terminal event.
        if (!claim.token || (!claim.ttlSeconds && !claim.expiresAt)) return;
        // A claim is dead only when expired AND its owning run is gone or
        // terminal — an active run keeps its token fenced even past the
        // TTL. Deletion re-validates under the claim lock so it cannot
        // race a reclaim that just installed a fresh claim; a contended
        // lock simply skips this best-effort GC.
        if (await canReuseExpiredStartClaim(basedir, opts?.tag, claim)) {
          await withRevalidatedClaim(
            basedir,
            claim.token,
            constraintPath,
            (latest) => canReuseExpiredStartClaim(basedir, opts?.tag, latest),
            () => deleteJSON(constraintPath)
          );
        }
        return;
      }
      if (!claim.token) return;
      if (!claim.ttlSeconds) {
        // A start claim without a retention TTL dies with its run — release
        // it here instead of leaving debris for lazy reclaim.
        await withRevalidatedClaim(
          basedir,
          claim.token,
          constraintPath,
          (latest) => latest.runId === runId && !latest.ttlSeconds,
          () => deleteJSON(constraintPath)
        );
        return;
      }
      // Same lock + re-validation discipline as settleClaimForDisposedHook:
      // this run is already terminal, so its expired claim may have been
      // reclaimed by a new run between the read above and the write below.
      await withRevalidatedClaim(
        basedir,
        claim.token,
        constraintPath,
        (latest) => latest.runId === runId && !!latest.ttlSeconds,
        async (latest) => {
          if (
            opts?.releaseUnmaterializedClaims &&
            latest.hookId === undefined &&
            latest.expiresAt === undefined
          ) {
            await deleteJSON(constraintPath);
          } else {
            await retainStartHookClaim(constraintPath, latest, now);
          }
        }
      );
    })
  );
}
