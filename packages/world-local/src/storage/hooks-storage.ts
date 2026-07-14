import path from 'node:path';
import { HookNotFoundError } from '@workflow/errors';
import type {
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
  paginatedFileSystemQuery,
  readJSON,
  readJSONWithFallback,
  taggedPath,
  UnsafeEntityIdError,
  writeExclusive,
  writeJSON,
} from '../fs.js';
import { filterHookData } from './filters.js';
import {
  hookRecoveryMarkerPath,
  isHookDisposalCommitted,
  withFileLock,
} from './helpers.js';
import {
  deleteHookByRunMarkerFile,
  ensureHookIndexes,
  findNewestIndexedHookCreatedEvent,
  type HookIndexLookup,
  listHookByRunMarkers,
  writeHookByRunMarker,
} from './hook-index.js';
import {
  type CurrentHookTokenConstraint,
  type HookTokenConstraint,
  hasFutureTokenExpiration,
  hookTokenConstraintPath,
  readHookTokenConstraint,
} from './hook-token-constraint.js';

type IndexedHookCreatedEvent = NonNullable<
  Awaited<ReturnType<typeof findNewestIndexedHookCreatedEvent>>
>;

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
 * Find the available `hook_created` event for a token or hookId via the
 * durable hook indexes (instead of scanning the whole event log).
 *
 * The availability checks below subsume the old scan's in-log closure
 * replay: the dispose lock is written before `hook_disposed` is
 * appended, the run entity is terminal before any terminal run event
 * is appended, and neither is ever deleted — so any closure visible
 * in the log is also visible to these checks.
 */
async function isHookCreatedEventAvailable(
  basedir: string,
  { event, tag }: IndexedHookCreatedEvent
): Promise<boolean> {
  if (
    !(await isRunActive(basedir, event.runId, tag)) &&
    !hasFutureTokenExpiration(event.eventData)
  ) {
    return false;
  }
  // Disposal is committed before its event, so the lock closes the Hook even
  // when a crash leaves the entity and event-log cleanup incomplete.
  return !(await isHookDisposalCommitted(basedir, event.correlationId, tag));
}

async function findHookCreatedEvent(
  basedir: string,
  index: HookIndexLookup
): Promise<IndexedHookCreatedEvent | null> {
  const indexed = await findNewestIndexedHookCreatedEvent(basedir, index);
  if (!indexed) return null;
  if (!(await isHookCreatedEventAvailable(basedir, indexed))) return null;
  return indexed;
}

function hookTokenConstraintFromEvent(
  event: HookCreatedEvent,
  tag: string | undefined
): CurrentHookTokenConstraint {
  return {
    type: 'current',
    token: event.eventData.token,
    hookId: event.correlationId,
    runId: event.runId,
    tag: tag ?? null,
    eventId: event.eventId,
    tokenExpiresAt: event.eventData.tokenExpiresAt,
  };
}

async function restoreHookEntityFromEvent(
  basedir: string,
  event: HookCreatedEvent,
  tag: string | undefined
): Promise<Hook> {
  const hook = hookFromCreatedEvent(event);
  // Marker before entity (see hook-index.ts crash-ordering invariant).
  await writeHookByRunMarker(basedir, hook.runId, hook.hookId, tag);
  await writeExclusive(
    taggedPath(basedir, 'hooks', hook.hookId, tag),
    JSON.stringify(hook, jsonReplacer, 2)
  );

  return hook;
}

// Admission repairs only the reservation. Hook reads restore the entity and
// by-run marker, keeping conflict checks free of unrelated filesystem writes.
export async function rebuildHookTokenConstraintFromEventLog(
  basedir: string,
  token: string
): Promise<HookTokenConstraint | null> {
  const indexed = await findHookCreatedEvent(basedir, { kind: 'token', token });
  if (!indexed) return null;
  const constraint = hookTokenConstraintFromEvent(indexed.event, indexed.tag);
  await writeJSON(hookTokenConstraintPath(basedir, token), constraint, {
    overwrite: true,
  });
  return constraint;
}

async function rebuildHookByTokenFromEventLog(
  basedir: string,
  token: string
): Promise<Hook | null> {
  const constraintPath = hookTokenConstraintPath(basedir, token);
  return withFileLock(constraintPath, async () => {
    const indexed = await findHookCreatedEvent(basedir, {
      kind: 'token',
      token,
    });
    if (!indexed) return null;
    await writeJSON(
      constraintPath,
      hookTokenConstraintFromEvent(indexed.event, indexed.tag),
      { overwrite: true }
    );
    return restoreHookEntityFromEvent(basedir, indexed.event, indexed.tag);
  });
}

async function rebuildHookByIdFromEventLog(
  basedir: string,
  hookId: string,
  tag?: string
): Promise<Hook | null> {
  const indexed = await findHookCreatedEvent(basedir, {
    kind: 'id',
    hookId,
    tag,
  });
  if (!indexed) return null;

  const constraintPath = hookTokenConstraintPath(
    basedir,
    indexed.event.eventData.token
  );
  return withFileLock(constraintPath, async () => {
    if (!(await isHookCreatedEventAvailable(basedir, indexed))) return null;
    // An ID-based repair must not replace a newer owner of the same token.
    const constraint = await readHookTokenConstraint(constraintPath);
    if (
      constraint &&
      (constraint.runId !== indexed.event.runId ||
        constraint.hookId !== indexed.event.correlationId)
    ) {
      return null;
    }
    if (!constraint) {
      await writeJSON(
        constraintPath,
        hookTokenConstraintFromEvent(indexed.event, indexed.tag),
        { overwrite: true }
      );
    }
    return restoreHookEntityFromEvent(basedir, indexed.event, indexed.tag);
  });
}

type HookByTokenLookup =
  | { type: 'found'; hook: Hook }
  | { type: 'recover' }
  | { type: 'unavailable' };

/**
 * Creates a hooks storage implementation using the filesystem.
 * Implements the Storage['hooks'] interface with hook CRUD operations.
 */
export function createHooksStorage(
  basedir: string,
  tag?: string
): Storage['hooks'] {
  async function findHookByToken(token: string): Promise<HookByTokenLookup> {
    const constraint = await readHookTokenConstraint(
      hookTokenConstraintPath(basedir, token)
    );
    if (!constraint || constraint.type !== 'current') {
      return { type: 'recover' };
    }
    const ownerTag = constraint.tag ?? undefined;
    const hook = await readJSONWithFallback(
      basedir,
      'hooks',
      constraint.hookId,
      HookSchema,
      ownerTag
    );
    if (!hook || hook.token !== token) return { type: 'recover' };
    if (
      !(await isRunActive(basedir, hook.runId, ownerTag)) &&
      !hasFutureTokenExpiration(constraint)
    ) {
      return { type: 'unavailable' };
    }
    return {
      type: 'found',
      hook: { ...hook, isWebhook: hook.isWebhook ?? true },
    };
  }

  async function get(hookId: string, params?: GetHookParams): Promise<Hook> {
    assertSafeEntityId('hookId', hookId);
    const hook =
      (await readJSONWithFallback(basedir, 'hooks', hookId, HookSchema, tag)) ??
      (await rebuildHookByIdFromEventLog(basedir, hookId, tag));
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
    const lookup = await findHookByToken(token);
    switch (lookup.type) {
      case 'found':
        return lookup.hook;
      case 'recover': {
        const hook = await rebuildHookByTokenFromEventLog(basedir, token);
        if (hook) return hook;
        throw new HookNotFoundError(token);
      }
      case 'unavailable':
        throw new HookNotFoundError(token);
      default: {
        const unknownLookup: never = lookup;
        throw new Error(
          `Unknown Hook token lookup: ${JSON.stringify(unknownLookup)}`
        );
      }
    }
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
    let hookPath: string;
    let hook: Hook | null;
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
      await deleteHookByRunMarkerFile(basedir, marker.fileId);
      continue;
    }
    if (!hook || hook.runId !== runId) {
      await deleteHookByRunMarkerFile(basedir, marker.fileId);
      continue;
    }

    const constraintPath = hookTokenConstraintPath(basedir, hook.token);
    const keepHook = await withFileLock(constraintPath, async () => {
      const constraint = await readHookTokenConstraint(constraintPath);
      const owned =
        constraint?.runId === hook.runId && constraint.hookId === hook.hookId;
      if (owned && hasFutureTokenExpiration(constraint)) return true;
      if (owned) await deleteJSON(constraintPath);
      return false;
    });
    if (keepHook) continue;

    await Promise.all([
      deleteJSON(
        hookRecoveryMarkerPath(basedir, hook.token, hook.runId, hook.hookId)
      ),
      deleteJSON(hookPath),
      deleteHookByRunMarkerFile(basedir, marker.fileId),
    ]);
  }
}
