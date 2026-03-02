import path from 'node:path';
import type {
  GetHookParams,
  Hook,
  ListHooksParams,
  PaginatedResponse,
  Storage,
} from '@workflow/world';
import { HookSchema } from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  deleteJSON,
  listJSONFiles,
  paginatedFileSystemQuery,
  readJSON,
} from '../fs.js';
import { filterHookData } from './filters.js';

/**
 * Creates a hooks storage implementation using the filesystem.
 * Implements the Storage['hooks'] interface with hook CRUD operations.
 */
export function createHooksStorage(basedir: string): Storage['hooks'] {
  // Helper function to find a hook by token (shared between getByToken)
  async function findHookByToken(token: string): Promise<Hook | null> {
    const hooksDir = path.join(basedir, 'hooks');
    const files = await listJSONFiles(hooksDir);

    for (const file of files) {
      const hookPath = path.join(hooksDir, `${file}.json`);
      const hook = await readJSON(hookPath, HookSchema);
      if (hook && hook.token === token) {
        return hook;
      }
    }

    return null;
  }

  async function get(hookId: string, params?: GetHookParams): Promise<Hook> {
    const hookPath = path.join(basedir, 'hooks', `${hookId}.json`);
    const hook = await readJSON(hookPath, HookSchema);
    if (!hook) {
      throw new Error(`Hook ${hookId} not found`);
    }
    const resolveData = params?.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
    return filterHookData(hook, resolveData);
  }

  async function getByToken(token: string): Promise<Hook> {
    const hook = await findHookByToken(token);
    if (!hook) {
      throw new Error(`Hook with token ${token} not found`);
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
      sortOrder: params.pagination?.sortOrder,
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
        // Hook files don't have ULID timestamps in filename
        // We need to read the file to get createdAt, but that's inefficient
        // So we return the hook's createdAt directly (item.createdAt will be used for sorting)
        // Return a dummy date to pass the null check, actual sorting uses item.createdAt
        return new Date(0);
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
      await deleteJSON(hookPath);
    }
  }
}
