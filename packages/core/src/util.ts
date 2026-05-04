import { waitUntil } from '@vercel/functions';
import { pluralize } from '@workflow/utils';

/**
 * Builds a workflow suspension log message based on the counts of steps,
 * hooks, and waits. The structured logger attaches the run context, so the
 * message itself only describes what's being enqueued.
 * @param stepCount - Number of steps to be enqueued
 * @param hookCount - Number of hooks to be enqueued
 * @param waitCount - Number of waits to be enqueued
 * @returns The formatted log message or null if all counts are 0
 */
export function buildWorkflowSuspensionMessage(
  stepCount: number,
  hookCount: number,
  waitCount: number
): string | null {
  if (stepCount === 0 && hookCount === 0 && waitCount === 0) {
    return null;
  }

  const parts = [];
  if (stepCount > 0) {
    parts.push(`${stepCount} ${pluralize('step', 'steps', stepCount)}`);
  }
  if (hookCount > 0) {
    parts.push(`${hookCount} ${pluralize('hook', 'hooks', hookCount)}`);
  }
  if (waitCount > 0) {
    parts.push(`${waitCount} ${pluralize('timer', 'timers', waitCount)}`);
  }

  const resumeMsgParts: string[] = [];
  if (stepCount > 0) {
    resumeMsgParts.push('steps are completed');
  }
  if (hookCount > 0) {
    resumeMsgParts.push('hooks are received');
  }
  if (waitCount > 0) {
    resumeMsgParts.push('timers have elapsed');
  }
  const resumeMsg = resumeMsgParts.join(' and ');

  return `${parts.join(' and ')} to be enqueued\n  Workflow will suspend and resume when ${resumeMsg}`;
}

/**
 * Generates a stream ID for a workflow run.
 * User-defined streams include a "user" segment for isolation from future system-defined streams.
 * Namespaces are base64-encoded to handle characters not allowed in Redis key names.
 *
 * @param runId - The workflow run ID
 * @param namespace - Optional namespace for the stream
 * @returns The stream ID in format: `strm_{ULID}_user_{base64(namespace)?}`
 */
export function getWorkflowRunStreamId(runId: string, namespace?: string) {
  const streamId = `${runId.replace('wrun_', 'strm_')}_user`;
  if (!namespace) {
    return streamId;
  }
  // Base64 encode the namespace to handle special characters that may not be allowed in Redis keys
  const encodedNamespace = Buffer.from(namespace, 'utf-8').toString(
    'base64url'
  );
  return `${streamId}_${encodedNamespace}`;
}

/**
 * Generate a stream ID for an abort signal's backing stream.
 * Uses the "_system_abort" namespace to isolate from user-defined streams.
 *
 * @param id - A unique identifier (typically a ULID)
 * @returns The stream ID in format: `strm_{id}_system_abort`
 */
export function getAbortStreamId(id: string) {
  return `strm_${id}_system_abort`;
}

const ABORT_TOKEN_PREFIX = 'abrt_';

/**
 * Derive the abort stream name from a hook token.
 * Hook tokens use the format `abrt_{id}`, and the corresponding stream is
 * `strm_{id}_system_abort`.
 */
export function getAbortStreamIdFromToken(hookToken: string): string {
  if (!hookToken.startsWith(ABORT_TOKEN_PREFIX)) {
    throw new Error(
      `Invalid abort hook token format: expected "abrt_" prefix, got "${hookToken}"`
    );
  }
  return getAbortStreamId(hookToken.slice(ABORT_TOKEN_PREFIX.length));
}

/**
 * A small wrapper around `waitUntil` that also returns
 * the result of the awaited promise.
 */
export async function waitedUntil<T>(fn: () => Promise<T>): Promise<T> {
  const result = fn();
  waitUntil(
    result.catch(() => {
      // Ignore error from the promise being rejected.
      // It's expected that the invoker of `waitedUntil`
      // will handle the error.
    })
  );
  return result;
}
