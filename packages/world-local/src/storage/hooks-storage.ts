import path from 'node:path';
import { HookNotFoundError } from '@workflow/errors';
import type {
  GetHookParams,
  Hook,
  ListHooksParams,
  PaginatedResponse,
  Storage,
} from '@workflow/world';
import { HookSchema } from '@workflow/world';
import { z } from 'zod';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  assertSafeEntityId,
  deleteJSON,
  listJSONFiles,
  paginatedFileSystemQuery,
  readJSON,
  readJSONWithFallback,
  writeJSON,
} from '../fs.js';
import { filterHookData } from './filters.js';
import { hashToken, hookRecoveryMarkerPath } from './helpers.js';

const HookTokenClaimSchema = z.object({
  token: z.string().optional(),
  hookId: z.string().optional(),
  runId: z.string(),
  eventId: z.string().optional(),
  ttlSeconds: z.number().int().positive().optional(),
  startEventId: z.string().optional(),
  createdAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  phase: z.enum(['start_claim', 'materialized', 'retained']).optional(),
  tag: z.string().optional(),
});

async function retainStartHookClaim(
  constraintPath: string,
  claim: z.infer<typeof HookTokenClaimSchema>,
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

  await writeJSON(
    constraintPath,
    {
      token: claim.token,
      hookId: claim.hookId,
      runId: claim.runId,
      eventId: claim.eventId,
      ttlSeconds: claim.ttlSeconds,
      startEventId: claim.startEventId,
      createdAt: claim.createdAt,
      phase: 'retained',
      tag: claim.tag,
      expiresAt,
    },
    { overwrite: true }
  );
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
      throw new HookNotFoundError(hookId);
    }
    const resolveData = params?.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
    return filterHookData(
      { ...hook, isWebhook: hook.isWebhook ?? true },
      resolveData
    );
  }

  async function getByToken(token: string): Promise<Hook> {
    const hook = await findHookByToken(token);
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
  const tokensDir = path.join(hooksDir, 'tokens');
  const now = new Date();

  for (const file of files) {
    const hookPath = path.join(hooksDir, `${file}.json`);
    const hook = await readJSON(hookPath, HookSchema);
    if (hook && hook.runId === runId) {
      // Delete the token constraint file to free up the token, and
      // delete the recovery marker (if any) for disk hygiene. The
      // marker's filename hash includes `(token, runId, hookId)` so
      // a leaked marker can never corrupt a different lifetime — but
      // cleaning it up here keeps the tokens/ directory from
      // accumulating recovered-hook sidecars over time.
      const constraintPath = path.join(
        hooksDir,
        'tokens',
        `${hashToken(hook.token)}.json`
      );
      const claim = await readJSON(constraintPath, HookTokenClaimSchema);
      if (claim?.runId === runId && claim.ttlSeconds) {
        await retainStartHookClaim(
          constraintPath,
          { ...claim, token: hook.token },
          now,
          hook.createdAt
        );
      } else {
        await deleteJSON(constraintPath);
      }
      await deleteJSON(
        hookRecoveryMarkerPath(basedir, hook.token, hook.runId, hook.hookId)
      );
      await deleteJSON(hookPath);
    }
  }

  for (const file of await listJSONFiles(tokensDir)) {
    if (file.endsWith('.recovery')) continue;
    const constraintPath = path.join(tokensDir, `${file}.json`);
    const claim = await readJSON(constraintPath, HookTokenClaimSchema);
    if (claim?.runId === runId && claim.ttlSeconds) {
      await retainStartHookClaim(constraintPath, claim, now);
    }
  }
}
