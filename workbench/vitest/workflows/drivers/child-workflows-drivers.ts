import { start } from 'workflow/api';
import {
  startAndWait,
  withChildCompletionHook,
} from '../patterns/child-workflows.js';

// Child that either succeeds or throws — exercises the failure path of
// withChildCompletionHook (the parent must still wake up).
export async function flakyChild(id: string, shouldFail: boolean) {
  'use workflow';
  if (shouldFail) {
    throw new Error(`child ${id} failed`);
  }
  return { id, ok: true };
}

// Spawnable wrapper (module-scope export so start() can register it).
export async function flakyChildWithCompletion(
  id: string,
  shouldFail: boolean,
  completionTokenArg: string
) {
  'use workflow';
  await withChildCompletionHook(
    () => flakyChild(id, shouldFail),
    completionTokenArg
  );
}

async function spawnFlakyChild(
  id: string,
  shouldFail: boolean,
  completionTokenArg: string
): Promise<void> {
  'use step';
  await start(flakyChildWithCompletion, [id, shouldFail, completionTokenArg]);
}

/** Parent that awaits one failing child and catches the rejection. */
export async function parentCatchesChildFailure(id: string) {
  'use workflow';
  try {
    const value = await startAndWait(`fail:${id}`, (token) =>
      spawnFlakyChild(id, true, token)
    );
    return { caught: false as const, value };
  } catch (error) {
    return {
      caught: true as const,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Promise.allSettled isolation: `failingId` fails, siblings succeed. */
export async function parentAllSettled(ids: string[], failingId: string) {
  'use workflow';
  const settled = await Promise.allSettled(
    ids.map((id) =>
      startAndWait<{ id: string; ok: boolean }>(`settle:${id}`, (token) =>
        spawnFlakyChild(id, id === failingId, token)
      )
    )
  );
  return settled.map((entry) =>
    entry.status === 'fulfilled'
      ? { status: 'fulfilled' as const, value: entry.value }
      : {
          status: 'rejected' as const,
          message:
            entry.reason instanceof Error
              ? entry.reason.message
              : String(entry.reason),
        }
  );
}
