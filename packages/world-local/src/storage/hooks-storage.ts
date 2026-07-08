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
 * Find the live `hook_created` event for a token or hookId via the
 * durable hook indexes (instead of scanning the whole event log).
 *
 * The liveness checks below subsume the old scan's in-log closure
 * replay: the dispose lock is written before `hook_disposed` is
 * appended, the run entity is terminal before any terminal run event
 * is appended, and neither is ever deleted — so any closure visible
 * in the log is also visible to these checks.
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
  // Marker before entity (see hook-index.ts crash-ordering invariant).
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
  const TokenClaimPointerSchema = z.object({
    hookId: z.string().optional(),
  });

  async function findHookByToken(token: string): Promise<Hook | null> {
    // Fast path: the token claim file points at the owning hookId.
    let claim: z.infer<typeof TokenClaimPointerSchema> | null = null;
    try {
      claim = await readJSON(
        hookTokenClaimPath(basedir, token),
        TokenClaimPointerSchema
      );
    } catch (error) {
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
        if (!UnsafeEntityIdError.is(error)) {
          throw error;
        }
      }
    }

    // Slow path for legacy states (e.g. a lost claim file while the
    // entity is still on disk).
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
  // instead of reading every live hook entity in the world.
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
        // Release the claim only if it still points at this hook — a
        // claimant may already hold a fresh claim for the token (see
        // `isHookTokenClaimReleasable`).
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
    await deleteHookByRunMarkerFile(basedir, marker.fileId);
  }
}
