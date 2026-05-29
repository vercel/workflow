import { RUN_ERROR_CODES, type RuntimeDecryptionError } from '@workflow/errors';
import type { World } from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { DECRYPTION_FAILURE_MAX_RETRIES } from './constants.js';

/**
 * Decide how to handle a {@link RuntimeDecryptionError} thrown while
 * replaying a workflow run.
 *
 * An AES-GCM authentication failure is terminal for the bytes/key of the
 * *current* attempt — we must never continue executing the workflow on top
 * of data we couldn't decrypt. But the failure is often *not* terminal for
 * the run: when the ciphertext came from a transiently truncated or
 * corrupted read of remotely-persisted data (e.g. a partial `/refs`
 * response, an edge-cache miss returning a partial 200, a proxy drop during
 * streaming), a fresh queue delivery re-fetches the event log and ref
 * payloads from scratch and can succeed.
 *
 * This mirrors the bounded-redelivery precedent used for replay timeouts
 * (`handleReplayBudgetExhausted`):
 *
 * - **Managed-platform Worlds** (`processExitTriggersQueueRedelivery === true`,
 *   e.g. `world-vercel`): on attempts <= {@link DECRYPTION_FAILURE_MAX_RETRIES}
 *   the run should be re-attempted via queue redelivery (the caller exits the
 *   process, which the platform turns into a redelivery). Once the retry
 *   budget is exhausted, the caller falls through to write `run_failed` with
 *   `RUNTIME_ERROR`.
 *
 * - **In-process Worlds** (`world-local`, dev servers, custom in-process
 *   Worlds): `process.exit()` would kill the user's host, and there is no
 *   queue to re-fetch from, so redelivery is never attempted — the caller
 *   writes `run_failed` immediately.
 *
 * This function performs no side effects beyond logging; it returns whether
 * the caller should redrive (exit for redelivery) so the exit/`run_failed`
 * decision stays at the single call site in the run handler.
 *
 * @returns `true` if the run should be redelivered (caller exits the
 *          process); `false` if the caller should write `run_failed`.
 */
export function shouldRedriveOnDecryptionFailure(args: {
  world: World;
  error: RuntimeDecryptionError;
  runId: string;
  workflowName: string;
  attempt: number;
}): boolean {
  const { world, error, runId, workflowName, attempt } = args;
  const runLogger = runtimeLogger.forRun(runId, workflowName);

  const canExitForRedelivery =
    world.processExitTriggersQueueRedelivery === true;

  // In-process Worlds: no queue to re-fetch from, and exiting would kill the
  // host. Fail the run immediately.
  if (!canExitForRedelivery) {
    return false;
  }

  if (attempt <= DECRYPTION_FAILURE_MAX_RETRIES) {
    runLogger.warn(
      'Decryption failed while replaying persisted data; re-attempting via queue redelivery (attempt <= maxRetries)',
      {
        attempt,
        maxRetries: DECRYPTION_FAILURE_MAX_RETRIES,
        errorCode: RUN_ERROR_CODES.RUNTIME_ERROR,
        operation: error.context?.operation,
        byteLength: error.context?.byteLength,
        formatPrefix: error.context?.formatPrefix,
      }
    );
    return true;
  }

  runLogger.error(
    'Decryption failed while replaying persisted data and max retries exceeded. Failing the run',
    {
      attempt,
      maxRetries: DECRYPTION_FAILURE_MAX_RETRIES,
      errorCode: RUN_ERROR_CODES.RUNTIME_ERROR,
      operation: error.context?.operation,
      byteLength: error.context?.byteLength,
      formatPrefix: error.context?.formatPrefix,
    }
  );
  return false;
}
