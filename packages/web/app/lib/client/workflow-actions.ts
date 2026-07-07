import {
  cancelRun as cancelRunServerAction,
  fetchHookToken as fetchHookTokenServerAction,
  recreateRun as recreateRunServerAction,
  reenqueueRun as reenqueueRunServerAction,
  resumeHook as resumeHookServerAction,
  wakeUpRun as wakeUpRunServerAction,
} from '~/lib/rpc-client';
import type {
  EnvMap,
  ResumeHookResult,
  StopSleepOptions,
  StopSleepResult,
} from '~/lib/types';
import { unwrapOrThrow } from './workflow-errors';

/** Cancel a workflow run */
export async function cancelRun(env: EnvMap, runId: string): Promise<void> {
  await unwrapOrThrow(cancelRunServerAction(env, runId));
}

/** Start a new workflow run */
export async function recreateRun(env: EnvMap, runId: string): Promise<string> {
  return unwrapOrThrow(recreateRunServerAction(env, runId));
}

/** Wake up a workflow run by re-enqueuing it */
export async function reenqueueRun(env: EnvMap, runId: string): Promise<void> {
  await unwrapOrThrow(reenqueueRunServerAction(env, runId));
}

/** Wake up a workflow run by interrupting any pending sleep() calls */
export async function wakeUpRun(
  env: EnvMap,
  runId: string,
  options?: StopSleepOptions
): Promise<StopSleepResult> {
  return unwrapOrThrow(wakeUpRunServerAction(env, runId, options));
}

export type { ResumeHookResult };

/** Resume a hook by sending a JSON payload */
export async function resumeHook(
  env: EnvMap,
  token: string,
  payload: unknown
): Promise<ResumeHookResult> {
  return unwrapOrThrow(resumeHookServerAction(env, token, payload));
}

/**
 * Fetch a single hook's secret token on demand.
 *
 * Used by the hooks list, where rows are metadata-only: the token is fetched
 * one hook at a time when the user reveals/copies it or resumes the hook.
 */
export async function fetchHookToken(
  env: EnvMap,
  runId: string,
  hookId: string
): Promise<string> {
  const { token } = await unwrapOrThrow(
    fetchHookTokenServerAction(env, runId, hookId)
  );
  return token;
}
