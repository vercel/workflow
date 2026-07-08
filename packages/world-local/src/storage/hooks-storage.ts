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
  HookSchema,
  isTerminalWorkflowRunStatus,
  WorkflowRunSchema,
} from '@workflow/world';
import { z } from 'zod';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  assertSafeEntityId,
  deleteJSON,
  jsonReplacer,
  listJSONFiles,
  paginatedFileSystemQuery,
  readJSON,
  readJSONWithFallback,
  taggedPath,
  UnsafeEntityIdError,
  writeExclusive,
} from '../fs.js';
import { filterHookData } from './filters.js';
import {
  hashToken,
  hookRecoveryMarkerPath,
  hookTokenClaimPath,
  isHookDisposalCommitted,
  releaseHookTokenClaimIfOwnedBy,
} from './helpers.js';
import {
  deleteHookByRunMarkerFile,
  ensureHookIndexes,
  findNewestIndexedHookCreatedEvent,
  listHookByRunMarkers,
  writeHookByRunMarker,
} from './hook-index.js';

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

/**
 * Find the live `hook_created` event for a token or hookId, using the
 * durable hook indexes instead of scanning the entire global event
 * log (which grew with total history and made every first-time hook
 * creation slower over time).
 *
 * The newest matching indexed event is subjected to the same two
 * liveness checks the historical full scan applied. Those checks also
 * subsume the scan's in-log closure replay (`hook_disposed` /
 * terminal run events): the dispose lock is durably written before
 * the `hook_disposed` event is appended, and the run entity is
 * durably terminal before any terminal run event is appended — and
 * neither is ever deleted — so any closure visible in the log is
 * also visible to these checks.
 */
async function findLiveHookCreatedEvent(
  basedir: string,
  index: { kind: 'token'; token: string } | { kind: 'id'; hookId: string },
  matches: (event: Event) => boolean,
  tag?: string
): Promise<(Event & HookCreatedEvent) | null> {
  const newest = await findNewestIndexedHookCreatedEvent(
    basedir,
    index,
    (event) => isMatchingHookCreatedEvent(event, matches),
    tag
  );
  if (!newest || !isMatchingHookCreatedEvent(newest, matches)) {
    return null;
  }

  if (await isTerminalRunCache(basedir, newest.runId, tag)) {
    return null;
  }

  // A committed disposal (dispose lock on disk) closes the hook even when
  // its `hook_disposed` event has not landed in the log yet — the disposer
  // writes the lock, releases the token claim and hook entity, and only
  // then appends the event. Rebuilding the caches from the log in that
  // window would resurrect a claim for a hook that is being torn down.
  if (await isHookDisposalCommitted(basedir, newest.correlationId, tag)) {
    return null;
  }

  return newest;
}

async function restoreHookCachesFromEvent(
  basedir: string,
  event: Event & HookCreatedEvent,
  tag?: string
): Promise<Hook> {
  const hook = hookFromCreatedEvent(event);

  const claimPath = path.join(
    basedir,
    'hooks',
    'tokens',
    `${hashToken(hook.token)}.json`
  );
  await writeExclusive(
    claimPath,
    JSON.stringify({
      token: hook.token,
      hookId: hook.hookId,
      runId: hook.runId,
      eventId: event.eventId,
    })
  );
  // Marker before entity: run-termination cleanup discovers hooks via
  // by-run markers, so the marker must be durable no later than the
  // entity it indexes (a dangling marker is skipped harmlessly).
  await writeHookByRunMarker(basedir, hook.runId, hook.hookId, tag);
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
    { kind: 'token', token },
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
    { kind: 'id', hookId },
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
  // Minimal read shape for the token-claim fast path below. The full
  // claim schema (with `eventId` semantics) lives in events-storage;
  // here we only need the pointer back to the hook entity.
  const TokenClaimPointerSchema = z.object({
    hookId: z.string().optional(),
  });

  // Helper function to find a hook by token (shared between getByToken)
  async function findHookByToken(token: string): Promise<Hook | null> {
    // Fast path: the token claim file is keyed by sha256(token) and
    // points at the owning hookId — an O(1) lookup that avoids reading
    // every live hook entity in the world.
    let claim: z.infer<typeof TokenClaimPointerSchema> | null = null;
    try {
      claim = await readJSON(
        hookTokenClaimPath(basedir, token),
        TokenClaimPointerSchema
      );
    } catch (error) {
      // A corrupt claim file falls through to the exhaustive scan.
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) {
        throw error;
      }
    }
    if (claim?.hookId) {
      try {
        const hook = await readJSONWithFallback(
          basedir,
          'hooks',
          claim.hookId,
          HookSchema,
          tag
        );
        if (hook && hook.token === token) {
          return { ...hook, isWebhook: hook.isWebhook ?? true };
        }
      } catch (error) {
        // A claim containing an unsafe hookId cannot point at a real
        // entity written by this storage layer — fall through.
        if (!UnsafeEntityIdError.is(error)) {
          throw error;
        }
      }
    }

    // Slow path: exhaustive scan over live hook entities. Kept for
    // legacy states (e.g. a crash-lost or manually removed claim file
    // while the entity is still on disk).
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
 */
export async function deleteAllHooksForRun(
  basedir: string,
  runId: string
): Promise<void> {
  // Discover this run's hooks via by-run markers (a prefix readdir)
  // instead of reading every live hook entity in the world — the old
  // exhaustive scan made every run termination O(total live hooks).
  // `ensureHookIndexes` backfills markers for hooks created by older
  // versions of this package.
  await ensureHookIndexes(basedir);

  for (const marker of await listHookByRunMarkers(basedir, runId)) {
    if (marker.hookId) {
      let hook: Hook | null = null;
      let hookPath: string | null = null;
      try {
        hookPath = taggedPath(basedir, 'hooks', marker.hookId, marker.tag);
        hook = await readJSON(hookPath, HookSchema);
      } catch (error) {
        if (
          !UnsafeEntityIdError.is(error) &&
          !(error instanceof SyntaxError || error instanceof z.ZodError)
        ) {
          throw error;
        }
      }
      if (hook && hookPath && hook.runId === runId) {
        // Release the token claim to free up the token — but only if it
        // still points at this hook: a claimant may have force-released
        // the terminal run's stale claim already (see
        // `isHookTokenClaimReleasable`) and hold a fresh claim of its
        // own, which an unconditional delete would destroy. Also delete
        // the recovery marker (if any) for disk hygiene. The
        // marker's filename hash includes `(token, runId, hookId)` so
        // a leaked marker can never corrupt a different lifetime — but
        // cleaning it up here keeps the tokens/ directory from
        // accumulating recovered-hook sidecars over time.
        await releaseHookTokenClaimIfOwnedBy(
          basedir,
          hook.token,
          hook.runId,
          hook.hookId
        );
        await deleteJSON(
          hookRecoveryMarkerPath(basedir, hook.token, hook.runId, hook.hookId)
        );
        await deleteJSON(hookPath);
      }
    }
    // Always reap the marker itself — including unreadable debris and
    // markers whose entity is already gone.
    await deleteHookByRunMarkerFile(basedir, marker.fileId);
  }
}
