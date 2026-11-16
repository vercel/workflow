import {
  HookConflictError,
  HookNotFoundError,
  ThrottleError,
  WorkflowStartError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type ResumedHook,
  resumeHook,
  resumeHookOnWorld,
} from './resume-hook.js';
import { getRun, type Run } from './run.js';
import {
  type StartHookOptions,
  type StartOptions,
  type StartOptionsBase,
  start,
  type WorkflowFunction,
  type WorkflowMetadata,
} from './start.js';

/**
 * Options for {@link resumeHookOrStart}: everything `start()` takes except
 * `experimental_hook`, whose token is the helper's first argument and whose
 * other fields sit here.
 */
export type ResumeHookOrStartOptions = Omit<
  StartOptionsBase,
  'experimental_hook'
> & {
  /** As `start({ deploymentId })`, for the run the helper starts. */
  deploymentId?: StartOptions['deploymentId'];
  /**
   * As `start({ experimental_hook: { experimental_minRetention } })`: keep the
   * token for at least this long after the run the helper starts, so later
   * calls with the token are refused instead of starting a new run.
   */
  experimental_minRetention?: StartHookOptions['experimental_minRetention'];
  /** As `start({ experimental_hook: { metadata } })`. */
  metadata?: StartHookOptions['metadata'];
  /**
   * How many start or resume calls to make before giving up, counting each.
   * Racing callers and a run that ends between calls each cost one. Default
   * {@link RESUME_HOOK_OR_START_MAX_ATTEMPTS}.
   */
  maxAttempts?: number;
};

/** What {@link resumeHookOrStart} did. */
export type ResumeHookOrStartResult<TResult> =
  | {
      /** No run held the token: this call started `run`, which now holds it. */
      action: 'started';
      run: Run<TResult>;
    }
  | {
      /** `payload` was delivered to the Hook of `run`, the token's owner. */
      action: 'resumed';
      run: Run<TResult>;
      hook: ResumedHook;
    };

/** Default for {@link ResumeHookOrStartOptions.maxAttempts}. */
export const RESUME_HOOK_OR_START_MAX_ATTEMPTS = 8;

/** Backoff before retrying a start whose outcome was unknown. */
const START_RETRY_DELAYS_MS = [100, 300, 900, 2_000];
/** Longest wait honoured from a World's `retryAfter`, per attempt. */
const MAX_RETRY_AFTER_MS = 10_000;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A World answer that says "not yet, try again after this long": a throttle,
 * or a Hook whose run is admitted but still being created.
 */
function retryAfterMs(error: unknown): number | undefined {
  if (ThrottleError.is(error) || WorkflowWorldError.is(error)) {
    const seconds = error.retryAfter;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds * 1000, 0), MAX_RETRY_AFTER_MS);
    }
  }
  return undefined;
}

/**
 * Delivers `payload` to the run that owns `token`, or starts `workflow` with
 * `args` as that owner when no run holds the token.
 *
 * This is the "start or route to the owner" pattern, with the retries it
 * needs:
 *
 * - It resumes the token first. If no Hook answers, it starts the workflow
 *   with `experimental_hook: { token }`, so at most one run is started however
 *   many callers race.
 * - A start refused because another caller just started the owner resumes
 *   that owner instead. A resume refused because the owner just ended starts
 *   a new run.
 * - A start whose outcome is unknown (`WorkflowStartError`) is retried with
 *   the same token, which can never admit a second owner. A World that asks
 *   to retry later (`retryAfter`) is retried after that wait.
 *
 * A started run receives `args`, not `payload`: pass the first payload in
 * `args` too, or read it from the run's Hook. In the workflow, read later
 * payloads with `createHook({ token })`.
 *
 * It throws `HookConflictError` naming the owner when a run that can no
 * longer receive payloads keeps the token, which happens when the owner
 * ended and `experimental_minRetention` still holds its token. Any other
 * error from `start()` or `resumeHook()` is thrown as is.
 *
 * Call it from host code or a step, like `resumeHook()`.
 *
 * @example
 * ```ts
 * import { resumeHookOrStart } from "workflow/api";
 * import { chatSession } from "@/workflows/chat-session";
 *
 * export async function POST(request: Request) {
 *   const { threadId, message } = await request.json();
 *   const { action, run } = await resumeHookOrStart(
 *     `chat:${threadId}`,
 *     message,
 *     chatSession,
 *     [threadId, message]
 *   );
 *   return Response.json({ runId: run.runId, started: action === "started" });
 * }
 * ```
 */
export async function resumeHookOrStart<
  TArgs extends unknown[],
  TResult,
  TPayload = unknown,
>(
  token: string,
  payload: TPayload,
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  options: ResumeHookOrStartOptions = {}
): Promise<ResumeHookOrStartResult<TResult>> {
  const {
    experimental_minRetention,
    metadata,
    maxAttempts = RESUME_HOOK_OR_START_MAX_ATTEMPTS,
    ...startOptions
  } = options;
  if (typeof token !== 'string' || token.length === 0) {
    throw new WorkflowWorldError(
      'resumeHookOrStart() needs a non-empty token.',
      { code: 'INVALID_ARGUMENT', field: 'token' }
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new WorkflowWorldError(
      'resumeHookOrStart() needs maxAttempts to be a positive integer.',
      { code: 'INVALID_ARGUMENT', field: 'maxAttempts' }
    );
  }

  const world = startOptions.world;
  const resume = (): Promise<ResumedHook> =>
    world
      ? resumeHookOnWorld(world, token, payload)
      : resumeHook(token, payload);
  // `start()`'s overloads split on `deploymentId`, which is a runtime value
  // here; the run's type is the caller's, as with `start()` itself.
  const startAny = start as unknown as (
    workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
    args: unknown[],
    options: StartOptions
  ) => Promise<Run<unknown>>;
  const startOwner = (): Promise<Run<TResult>> =>
    startAny(workflow, args, {
      ...startOptions,
      experimental_hook: {
        token,
        ...(experimental_minRetention !== undefined && {
          experimental_minRetention,
        }),
        ...(metadata !== undefined && { metadata }),
      },
    } as StartOptions) as Promise<Run<TResult>>;

  // The owner a start was last refused by, and whether a resume then found
  // its Hook gone. A second refusal naming that same owner means it holds the
  // token without being able to receive (it ended, and retains the token).
  let refusedBy: string | undefined;
  let refusedByIsGone = false;
  let lastError: unknown;
  let next: 'resume' | 'start' = 'resume';
  let startRetries = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (next === 'resume') {
      try {
        const hook = await resume();
        return {
          action: 'resumed',
          run: getRun<TResult>(hook.runId),
          hook,
        };
      } catch (error) {
        lastError = error;
        if (HookNotFoundError.is(error)) {
          // No Hook answers for the token: it is free, or its owner ended.
          if (refusedBy !== undefined) refusedByIsGone = true;
          next = 'start';
          continue;
        }
        const wait = retryAfterMs(error);
        if (wait !== undefined) {
          await delay(wait);
          continue;
        }
        throw error;
      }
    }

    try {
      const run = await startOwner();
      return { action: 'started', run };
    } catch (error) {
      lastError = error;
      if (HookConflictError.is(error)) {
        const owner = error.conflictingRunId;
        if (owner !== undefined && owner === refusedBy && refusedByIsGone) {
          // The same owner refused us again after its Hook stopped answering:
          // it ended and its retention keeps the token.
          throw error;
        }
        if (owner !== refusedBy) refusedByIsGone = false;
        refusedBy = owner;
        next = 'resume';
        continue;
      }
      if (WorkflowStartError.is(error)) {
        // Unknown outcome: the same token either makes us the owner or names
        // the owner, so retrying is safe.
        const backoff =
          START_RETRY_DELAYS_MS[
            Math.min(startRetries, START_RETRY_DELAYS_MS.length - 1)
          ];
        startRetries++;
        await delay(backoff);
        continue;
      }
      const wait = retryAfterMs(error);
      if (wait !== undefined) {
        await delay(wait);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}
