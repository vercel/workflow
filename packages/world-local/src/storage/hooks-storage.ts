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
} from '../fs.js';
import { filterHookData } from './filters.js';
import {
  hashToken,
  hookRecoveryMarkerPath,
  isHookDisposalCommitted,
  releaseHookTokenClaimIfOwnedBy,
} from './helpers.js';

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

  // A committed disposal (dispose lock on disk) closes the hook even when
  // its `hook_disposed` event has not landed in the log yet — the disposer
  // writes the lock, releases the token claim and hook entity, and only
  // then appends the event. Rebuilding the caches from the log in that
  // window would resurrect a claim for a hook that is being torn down.
  if (
    liveEvent &&
    (await isHookDisposalCommitted(basedir, liveEvent.correlationId, tag))
  ) {
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
 */
export async function deleteAllHooksForRun(
  basedir: string,
  runId: string
): Promise<void> {
  const hooksDir = path.join(basedir, 'hooks');
  const files = await listJSONFiles(hooksDir);

  for (const file of files) {
    const hookPath = path.join(hooksDir, `${file}.json`);
    const hook = await readJSON(hookPath, HookSchema);
    if (hook && hook.runId === runId) {
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
}
