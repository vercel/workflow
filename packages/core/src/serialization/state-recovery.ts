import { FatalError } from '@workflow/errors';
import { runtimeLogger } from '../logger.js';
import { getWorldLazy } from '../runtime/get-world-lazy.js';
import type { PayloadKey } from './encryption.js';
import { decodeFormatPrefix, peekFormatPrefix } from './format.js';
import { StateContext, stateSourceId } from './state-refs.js';

const MAX_PAGES = 1000;
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * Reading the run's log to rebuild frozen state failed for a reason that
 * may pass (the World could not be reached, for example). The step executors
 * rethrow it so the delivery is retried, instead of recording the user's step
 * as failed and spending one of its retries.
 */
export class WorkflowStateRecoveryError extends Error {
  override name = 'WorkflowStateRecoveryError';

  static is(value: unknown): value is WorkflowStateRecoveryError {
    return (
      value instanceof Error && value.name === 'WorkflowStateRecoveryError'
    );
  }
}

/** Recovery can never succeed for this log: retrying the step would fail the same way. */
function fatal(message: string): FatalError {
  return new FatalError(
    `Cannot rebuild the frozen state in this step's input: ${message}`
  );
}

/** Reads from the World; any failure is one recovery may get past next time. */
async function read<T>(what: string, fetch: () => Promise<T>): Promise<T> {
  try {
    return await fetch();
  } catch (cause) {
    throw Object.assign(
      new WorkflowStateRecoveryError(
        `Could not read the run's ${what} to rebuild frozen state: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      ),
      { cause }
    );
  }
}

/**
 * Rebuilds the frozen state versions a step input refers to when the step
 * runs without the replay that produced them (for example a retry in a new
 * invocation). Reads the run input, hook payloads and step outputs, never step
 * inputs, and runs no workflow code. Called only when the input refers to
 * records a fresh context lacks.
 */
export async function recoverStateContext(
  runId: string,
  key: PayloadKey | undefined,
  data: unknown
): Promise<StateContext | undefined> {
  if (!(data instanceof Uint8Array) || peekFormatPrefix(data) !== 'devl')
    return undefined;
  const startedAt = Date.now();
  const world = await getWorldLazy();
  const context = new StateContext();
  const { prepareReplayPayload } = await import('../serialization.js');
  const ingest = async (value: unknown, source?: string) => {
    if (value === undefined) return;
    const prepared = (await prepareReplayPayload(value, key)).data;
    if (
      !(prepared instanceof Uint8Array) ||
      peekFormatPrefix(prepared) !== 'devl'
    )
      return;
    context.stats.recoveryBytes += prepared.byteLength;
    if (context.stats.recoveryBytes > MAX_BYTES)
      throw fatal('the run log is larger than the 256 MiB recovery limit');
    context.ingest(decodeFormatPrefix(prepared).payload, source);
  };
  const run = await read('input', () =>
    world.runs.get(runId, { resolveData: 'all' })
  );
  await ingest(run.input, stateSourceId('run-input'));
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const events = await read('events', () =>
      world.events.list({
        runId,
        resolveData: 'skip-step-inputs',
        pagination: { cursor, sortOrder: 'asc', limit: 1000 },
      })
    );
    context.stats.recoveryFetches++;
    // Versions build on earlier ones, so ingest in log order.
    for (const event of events.data) {
      if (event.eventType === 'hook_received')
        await ingest(event.eventData?.payload, stateSourceId(event));
      else if (event.eventType === 'step_completed')
        await ingest(event.eventData?.result);
    }
    if (!events.hasMore) {
      context.stats.recoveryMs = Date.now() - startedAt;
      runtimeLogger.debug('Rebuilt frozen state from the run log', {
        workflowRunId: runId,
        pages: context.stats.recoveryFetches,
        bytes: context.stats.recoveryBytes,
        durationMs: context.stats.recoveryMs,
      });
      return context;
    }
    if (!events.cursor || seen.has(events.cursor))
      throw new WorkflowStateRecoveryError(
        'The run log cursor did not advance while rebuilding frozen state'
      );
    seen.add(events.cursor);
    cursor = events.cursor;
  }
  throw fatal('the run log has more than 1000 pages');
}
