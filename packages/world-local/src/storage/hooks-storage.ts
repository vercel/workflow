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
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  assertSafeEntityId,
  deleteJSON,
  jsonReplacer,
  paginatedFileSystemQuery,
  readJSON,
  readJSONWithFallback,
  taggedPath,
  writeExclusive,
} from '../fs.js';
import { filterHookData } from './filters.js';
import {
  hookRecoveryMarkerPath,
  hookTokenConstraintPath,
  isHookDisposalCommitted,
  withHookTokenConstraintLock,
} from './helpers.js';
import {
  deleteHookByRunMarkerFile,
  ensureHookIndexes,
  findNewestIndexedHookCreatedEvent,
  listHookByRunMarkers,
  writeHookByRunMarker,
} from './hook-index.js';
import {
  type HookTokenConstraint,
  hasFutureTokenExpiration,
  readHookTokenConstraint,
} from './hook-token-constraint.js';

function isMatchingHookCreatedEvent(
  event: Event,
  index: { kind: 'token'; token: string } | { kind: 'id'; hookId: string }
): event is HookCreatedEvent {
  if (event.eventType !== 'hook_created') return false;
  return index.kind === 'token'
    ? event.eventData.token === index.token
    : event.correlationId === index.hookId;
}

function hookFromCreatedEvent(event: HookCreatedEvent): Hook {
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

async function isRunActive(
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
  return run !== null && !isTerminalWorkflowRunStatus(run.status);
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
  tag?: string
): Promise<HookCreatedEvent | null> {
  const event = await findNewestIndexedHookCreatedEvent(
    basedir,
    index,
    (candidate) => isMatchingHookCreatedEvent(candidate, index),
    tag
  );
  if (!event || !isMatchingHookCreatedEvent(event, index)) return null;

  if (!(await isRunActive(basedir, event.runId, tag))) {
    return null;
  }

  // A committed disposal closes the hook before its event is appended.
  if (await isHookDisposalCommitted(basedir, event.correlationId, tag)) {
    return null;
  }

  return event;
}

function hookTokenConstraintFromEvent(
  event: HookCreatedEvent
): HookTokenConstraint {
  return {
    type: 'pinned',
    token: event.eventData.token,
    hookId: event.correlationId,
    runId: event.runId,
    eventId: event.eventId,
    tokenExpiresAt: event.eventData.tokenExpiresAt,
  };
}

async function restoreHookCachesFromEvent(
  basedir: string,
  event: HookCreatedEvent,
  tag: string | undefined
): Promise<Hook> {
  await writeExclusive(
    hookTokenConstraintPath(basedir, event.eventData.token),
    JSON.stringify(hookTokenConstraintFromEvent(event))
  );
  const hook = hookFromCreatedEvent(event);
  // Marker before entity (see hook-index.ts crash-ordering invariant).
  await writeHookByRunMarker(basedir, hook.runId, hook.hookId, tag);
  await writeExclusive(
    taggedPath(basedir, 'hooks', hook.hookId, tag),
    JSON.stringify(hook, jsonReplacer, 2)
  );

  return hook;
}

export async function rebuildHookTokenConstraintFromEventLog(
  basedir: string,
  token: string,
  tag?: string
): Promise<HookTokenConstraint | null> {
  const event = await findNewestIndexedHookCreatedEvent(
    basedir,
    { kind: 'token', token },
    (candidate) =>
      candidate.eventType === 'hook_created' &&
      candidate.eventData.token === token,
    tag
  );
  if (!event || event.eventType !== 'hook_created') return null;
  if (await isHookDisposalCommitted(basedir, event.correlationId, tag)) {
    return null;
  }

  if (
    !(await isRunActive(basedir, event.runId, tag)) &&
    !hasFutureTokenExpiration(event.eventData)
  ) {
    return null;
  }
  await restoreHookCachesFromEvent(basedir, event, tag);
  return hookTokenConstraintFromEvent(event);
}

export async function rebuildLiveHookByTokenFromEventLog(
  basedir: string,
  token: string,
  tag?: string
): Promise<Hook | null> {
  const event = await findLiveHookCreatedEvent(
    basedir,
    { kind: 'token', token },
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
  async function findHookByToken(token: string): Promise<Hook | null> {
    const constraint = await readHookTokenConstraint(
      hookTokenConstraintPath(basedir, token)
    );
    if (!constraint) return null;
    const hook = await readJSONWithFallback(
      basedir,
      'hooks',
      constraint.hookId,
      HookSchema,
      tag
    );
    if (!hook || hook.token !== token) return null;
    if (
      !(await isRunActive(basedir, hook.runId, tag)) &&
      !hasFutureTokenExpiration(constraint)
    ) {
      return null;
    }
    return { ...hook, isWebhook: hook.isWebhook ?? true };
  }

  async function get(hookId: string, params?: GetHookParams): Promise<Hook> {
    assertSafeEntityId('hookId', hookId);
    const hook =
      (await readJSONWithFallback(basedir, 'hooks', hookId, HookSchema, tag)) ??
      (await rebuildLiveHookByIdFromEventLog(basedir, hookId, tag));
    if (!hook) {
      throw new HookNotFoundError(hookId);
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
    if (!hook) throw new HookNotFoundError(token);
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
    if (!marker.hookId) {
      await deleteHookByRunMarkerFile(basedir, marker.fileId);
      continue;
    }
    const hookPath = taggedPath(basedir, 'hooks', marker.hookId, marker.tag);
    const hook = await readJSON(hookPath, HookSchema);
    if (hook?.runId === runId) {
      const constraintPath = hookTokenConstraintPath(basedir, hook.token);
      const keepHook = await withHookTokenConstraintLock(
        constraintPath,
        async () => {
          const constraint = await readHookTokenConstraint(constraintPath);
          const owned =
            constraint?.runId === hook.runId &&
            constraint.hookId === hook.hookId;
          if (owned && hasFutureTokenExpiration(constraint)) return true;
          if (owned) await deleteJSON(constraintPath);
          return false;
        }
      );

      if (!keepHook) {
        await deleteJSON(
          hookRecoveryMarkerPath(basedir, hook.token, hook.runId, hook.hookId)
        );
        await deleteJSON(hookPath);
        await deleteHookByRunMarkerFile(basedir, marker.fileId);
      }
    } else {
      await deleteHookByRunMarkerFile(basedir, marker.fileId);
    }
  }
}
