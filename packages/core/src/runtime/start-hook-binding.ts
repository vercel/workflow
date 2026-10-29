import { WorkflowRuntimeError } from '@workflow/errors';
import {
  type Event,
  type RunInput,
  startHookId,
  type WorkflowRun,
} from '@workflow/world';

/**
 * The start Hook of a run created with `start(workflow, args, { hook })`.
 *
 * The admission that creates the run also creates this Hook, under an id
 * derived from the run's id, so it exists (and can be resumed) before the
 * workflow body runs, and no `hook_created` is ever written for it. The
 * workflow's `createHook({ token })` with this token binds to `hookId`
 * instead of minting a new one.
 */
export interface RunStartHook {
  readonly token: string;
  readonly hookId: string;
  /**
   * `start({ hook: { experimental_minRetention } })`'s deadline, when set.
   * Only decides whether a disposal still has to be written when the run
   * ends (a retained token is not released by the run's end), exactly as a
   * `hook_created`'s `tokenRetentionUntil` does for an ordinary Hook.
   */
  readonly tokenRetentionUntil?: Date;
}

interface StartHookSource {
  token: string;
  tokenRetentionUntil?: Date;
}

function sourceOf(value: unknown): StartHookSource | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { token, tokenRetentionUntil } = value as {
    token?: unknown;
    tokenRetentionUntil?: unknown;
  };
  if (typeof token !== 'string' || token.length === 0) return undefined;
  if (
    tokenRetentionUntil instanceof Date ||
    typeof tokenRetentionUntil === 'string' ||
    typeof tokenRetentionUntil === 'number'
  ) {
    const at = new Date(tokenRetentionUntil);
    if (!Number.isNaN(+at)) return { token, tokenRetentionUntil: at };
  }
  return { token };
}

/**
 * The run's start Hook, or `undefined` for a run started without one.
 *
 * Read, in order, from the log's `run_created.eventData.startHook` (the first
 * event of the log, immutable), the queue message's `runInput.startHook` (the
 * log may not hold `run_created` yet), and `workflowRun.startHook`. Every
 * replay must bind the same token, so sources that are present must agree;
 * one that disagrees is a World bug and throws rather than binding a
 * different id on some replays.
 *
 * Pure and synchronous: no I/O, and for a run without a start Hook it reads
 * three fields and returns.
 */
export function resolveRunStartHook({
  events,
  workflowRun,
  runInput,
}: {
  events: readonly Event[] | undefined;
  workflowRun: Pick<WorkflowRun, 'runId'> & { startHook?: unknown };
  runInput?: Pick<RunInput, 'startHook'> | undefined;
}): RunStartHook | undefined {
  const runCreated = events?.find((e) => e.eventType === 'run_created');
  const sources: [string, StartHookSource | undefined][] = [
    [
      'run_created',
      sourceOf(
        runCreated && 'eventData' in runCreated
          ? (runCreated.eventData as { startHook?: unknown } | undefined)
              ?.startHook
          : undefined
      ),
    ],
    ['runInput', sourceOf(runInput?.startHook)],
    ['run', sourceOf(workflowRun.startHook)],
  ];
  let found: StartHookSource | undefined;
  let from: string | undefined;
  for (const [source, candidate] of sources) {
    if (candidate === undefined) continue;
    if (found === undefined) {
      found = candidate;
      from = source;
    } else if (candidate.token !== found.token) {
      throw new WorkflowRuntimeError(
        `Workflow run "${workflowRun.runId}" has conflicting start Hook tokens: ${from} and ${source} carry different ones.`
      );
    } else if (
      found.tokenRetentionUntil === undefined &&
      candidate.tokenRetentionUntil !== undefined
    ) {
      found = { ...found, tokenRetentionUntil: candidate.tokenRetentionUntil };
    }
  }
  if (found === undefined) return undefined;
  return {
    token: found.token,
    hookId: startHookId(workflowRun.runId),
    ...(found.tokenRetentionUntil !== undefined
      ? { tokenRetentionUntil: found.tokenRetentionUntil }
      : {}),
  };
}

/**
 * Mint a hook correlation id, redrawing on the one id this run must never
 * mint: its start Hook's. The draw is a pure function of the run's ULID
 * sequence, so the redraw (if any) is the same on every replay. Run ids
 * tagged by their World never collide with a minted id at all, so the loop
 * almost never runs twice.
 */
export function mintHookCorrelationId(
  generateUlid: () => string,
  startHook: Pick<RunStartHook, 'hookId'> | undefined
): string {
  let id = `hook_${generateUlid()}`;
  while (startHook !== undefined && id === startHook.hookId) {
    id = `hook_${generateUlid()}`;
  }
  return id;
}
