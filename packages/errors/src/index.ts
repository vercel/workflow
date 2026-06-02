import { parseDurationToDate } from '@workflow/utils';

import type { StringValue } from 'ms';

// Note: `Ansi` helpers live under the `@workflow/errors/ansi` subpath so the
// main entry point doesn't pull `chalk` (and its ESM machinery) into every
// consumer — most places that `import from '@workflow/errors'` only want the
// error classes and never render framed messages.

const BASE_URL = 'https://workflow-sdk.dev/err';

/**
 * @internal
 * Check if a value is an Error without relying on Node.js utilities.
 * This is needed for error classes that can be used in VM contexts where
 * Node.js imports are not available.
 */
function isError(value: unknown): value is { name: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'message' in value
  );
}

/**
 * @internal
 * Compose a framed-detail body for an error message — same `╰▶` /
 * `├▶` box-drawing structure used by `ContextViolationError` (in
 * `@workflow/core`), so every error class with a hint or docs slug
 * renders consistently:
 *
 *     <title>
 *     ├▶ hint: <hint>
 *     ╰▶ docs: https://workflow-sdk.dev/err/<slug>
 *
 * Plain text only — no ANSI here, since `@workflow/errors`'s main entry
 * stays chalk-free. The runtime logger renders the same chars with
 * dim styling at log time.
 *
 * Returns just `title` when there are no details to frame. Multi-line
 * detail values are indented under their branch so the tree stays
 * readable.
 */
function appendFramedDetails(
  title: string,
  details: ReadonlyArray<{ label: 'hint' | 'docs'; value: string }>
): string {
  if (details.length === 0) return title;
  const lines = [title];
  details.forEach((detail, index) => {
    const isLast = index === details.length - 1;
    const head = isLast ? '╰▶ ' : '├▶ ';
    const cont = isLast ? '   ' : '│  ';
    const text = `${detail.label}: ${detail.value}`;
    text
      .split('\n')
      .forEach((line, i) => lines.push(`${i === 0 ? head : cont}${line}`));
  });
  return lines.join('\n');
}

function buildFramedDetails(
  hint: string | undefined,
  slug: ErrorSlug | undefined
): ReadonlyArray<{ label: 'hint' | 'docs'; value: string }> {
  const out: Array<{ label: 'hint' | 'docs'; value: string }> = [];
  if (hint) out.push({ label: 'hint', value: hint });
  if (slug) out.push({ label: 'docs', value: `${BASE_URL}/${slug}` });
  return out;
}

/**
 * @internal
 * All the slugs of the errors used for documentation links.
 */
export const ERROR_SLUGS = {
  NODE_JS_MODULE_IN_WORKFLOW: 'node-js-module-in-workflow',
  START_INVALID_WORKFLOW_FUNCTION: 'start-invalid-workflow-function',
  SERIALIZATION_FAILED: 'serialization-failed',
  WEBHOOK_INVALID_RESPOND_WITH_VALUE: 'webhook-invalid-respond-with-value',
  WEBHOOK_RESPONSE_NOT_SENT: 'webhook-response-not-sent',
  FETCH_IN_WORKFLOW_FUNCTION: 'fetch-in-workflow',
  TIMEOUT_FUNCTIONS_IN_WORKFLOW: 'timeout-in-workflow',
  HOOK_CONFLICT: 'hook-conflict',
  CORRUPTED_EVENT_LOG: 'corrupted-event-log',
  STEP_NOT_REGISTERED: 'step-not-registered',
  WORKFLOW_NOT_REGISTERED: 'workflow-not-registered',
  RUNTIME_DECRYPTION_FAILED: 'runtime-decryption-failed',
} as const;

type ErrorSlug = (typeof ERROR_SLUGS)[keyof typeof ERROR_SLUGS];

interface WorkflowErrorOptions extends ErrorOptions {
  /**
   * The slug of the error. This will be used to generate a link to the error documentation.
   */
  slug?: ErrorSlug;
}

/**
 * The base class for all Workflow-related errors.
 *
 * This error is thrown by the Workflow SDK when internal operations fail.
 * You can use this class with `instanceof` to catch any Workflow SDK error.
 *
 * @example
 * ```ts
 * try {
 *   await getRun(runId);
 * } catch (error) {
 *   if (error instanceof WorkflowError) {
 *     console.error('Workflow SDK error:', error.message);
 *   }
 * }
 * ```
 */
export class WorkflowError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: WorkflowErrorOptions) {
    const msgDocs = appendFramedDetails(
      message,
      buildFramedDetails(undefined, options?.slug)
    );
    super(msgDocs, { cause: options?.cause });
    // Only set `cause` when actually provided. Assigning `undefined`
    // unconditionally makes `cause` an enumerable own property, which
    // pollutes `util.inspect(err)` output with `{ cause: undefined, … }`
    // on every no-cause subclass. The `super(...)` call above already
    // conditionally sets non-enumerable `.cause` when `options.cause`
    // is provided.
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }

    if (options?.cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
    }
  }

  static is(value: unknown): value is WorkflowError {
    return isError(value) && value.name === 'WorkflowError';
  }
}

/**
 * Thrown when a world (storage backend) operation fails unexpectedly.
 *
 * This is the catch-all error for world implementations. Specific,
 * well-known failure modes have dedicated error types (e.g.
 * EntityConflictError, RunExpiredError, ThrottleError). This error
 * covers everything else — validation failures, missing entities
 * without a dedicated type, or unexpected HTTP errors from world-vercel.
 */
export class WorkflowWorldError extends WorkflowError {
  status?: number;
  code?: string;
  url?: string;
  /** Retry-After value in seconds, present on 429 and 425 responses */
  retryAfter?: number;

  constructor(
    message: string,
    options?: {
      status?: number;
      url?: string;
      code?: string;
      retryAfter?: number;
      cause?: unknown;
    }
  ) {
    super(message, {
      cause: options?.cause,
    });
    this.name = 'WorkflowWorldError';
    this.status = options?.status;
    this.code = options?.code;
    this.url = options?.url;
    this.retryAfter = options?.retryAfter;
  }

  static is(value: unknown): value is WorkflowWorldError {
    return isError(value) && value.name === 'WorkflowWorldError';
  }
}

/**
 * Thrown when a workflow run fails during execution.
 *
 * This error indicates that the workflow encountered a fatal error and cannot
 * continue. It is thrown when awaiting `run.returnValue` on a run whose status
 * is `'failed'`. The `cause` property contains the underlying error with its
 * message, stack trace, and optional error code.
 *
 * Use the static `WorkflowRunFailedError.is()` method for type-safe checking
 * in catch blocks.
 *
 * @example
 * ```ts
 * import { WorkflowRunFailedError } from "workflow/internal/errors";
 *
 * try {
 *   const result = await run.returnValue;
 * } catch (error) {
 *   if (WorkflowRunFailedError.is(error)) {
 *     console.error(`Run ${error.runId} failed:`, error.cause.message);
 *   }
 * }
 * ```
 */
export class WorkflowRunFailedError extends WorkflowError {
  runId: string;
  /**
   * The high-level error category (e.g. USER_ERROR, RUNTIME_ERROR) for the
   * failed run, from the run_failed event's `errorCode` field.
   */
  errorCode?: string;
  /**
   * The original thrown value from the failed workflow run, hydrated through
   * the workflow serialization pipeline. Preserves the original type identity
   * (Error subclasses, FatalError, custom classes with WORKFLOW_SERIALIZE, etc.)
   * and custom properties (cause chains, etc.).
   *
   * Note: any JavaScript value can be thrown, so this is typed as `unknown`.
   * Typical values are Error instances, but strings, objects, etc. are also
   * possible.
   */
  declare cause: unknown;

  constructor(
    runId: string,
    error: unknown,
    options: { errorCode?: string } = {}
  ) {
    // Derive a human-readable message from the hydrated thrown value.
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : error && typeof error === 'object' && 'message' in error
            ? String((error as { message: unknown }).message)
            : 'Unknown error';

    super(`Workflow run "${runId}" failed: ${message}`, {
      cause: error,
    });
    this.name = 'WorkflowRunFailedError';
    this.runId = runId;
    if (options.errorCode !== undefined) {
      this.errorCode = options.errorCode;
    }
  }

  static is(value: unknown): value is WorkflowRunFailedError {
    return isError(value) && value.name === 'WorkflowRunFailedError';
  }
}

/**
 * Thrown when attempting to get results from an incomplete workflow run.
 *
 * This error occurs when you try to access the result of a workflow
 * that is still running or hasn't completed yet.
 */
export class WorkflowRunNotCompletedError extends WorkflowError {
  runId: string;
  status: string;

  constructor(runId: string, status: string) {
    super(`Workflow run "${runId}" has not completed`, {});
    this.name = 'WorkflowRunNotCompletedError';
    this.runId = runId;
    this.status = status;
  }

  static is(value: unknown): value is WorkflowRunNotCompletedError {
    return isError(value) && value.name === 'WorkflowRunNotCompletedError';
  }
}

/**
 * Thrown when the Workflow runtime encounters an internal error.
 *
 * This error indicates an issue with workflow execution, such as
 * serialization failures, starting an invalid workflow function, or
 * other runtime problems.
 */
export class WorkflowRuntimeError extends WorkflowError {
  constructor(message: string, options?: WorkflowErrorOptions) {
    super(message, {
      ...options,
    });
    this.name = 'WorkflowRuntimeError';
  }

  static is(value: unknown): value is WorkflowRuntimeError {
    return isError(value) && value.name === 'WorkflowRuntimeError';
  }
}

/**
 * Thrown when the persisted workflow event log cannot be replayed because it
 * contains orphaned, duplicate, or mismatched events.
 *
 * This is a runtime/infrastructure failure rather than user code throwing.
 * When this reaches run failure handling, it is recorded with the distinct
 * `CORRUPTED_EVENT_LOG` code so worlds and backends can track it separately
 * from generic runtime failures.
 */
export class CorruptedEventLogError extends WorkflowRuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, {
      ...options,
      slug: ERROR_SLUGS.CORRUPTED_EVENT_LOG,
    });
    this.name = 'CorruptedEventLogError';
  }

  static is(value: unknown): value is CorruptedEventLogError {
    return isError(value) && value.name === 'CorruptedEventLogError';
  }
}

/**
 * Optional structured context attached to a {@link RuntimeDecryptionError},
 * carried over from the underlying decrypt call site to help diagnose the
 * failure without poking through stacks.
 */
export interface RuntimeDecryptionErrorContext {
  /** The operation that failed — useful to tell encrypt vs decrypt apart. */
  operation?: 'encrypt' | 'decrypt';
  /** Byte length of the input payload at the time of the failure. */
  byteLength?: number;
  /**
   * The first 4 bytes of the input payload, decoded as UTF-8 if printable.
   * Useful for telling apart truncated-but-valid-looking encrypted payloads
   * from completely unrelated corruption (e.g. an HTML error page surfaced
   * as a 200 OK).
   */
  formatPrefix?: string;
}

/**
 * Thrown when the SDK's built-in AES-GCM encryption layer fails to encrypt
 * or decrypt a workflow payload.
 *
 * This is an internal SDK failure — user code never invokes the SDK's
 * encryption primitives directly. Common causes:
 *
 * - A ciphertext / auth tag mismatch, typically surfaced as the native Web
 *   Crypto `OperationError: The operation failed for an operation-specific
 *   reason`. Usually caused by ciphertext mutation or truncation in transit
 *   between storage and read (truncated HTTP response, edge-cache miss
 *   returning a partial 200, proxy drop during streaming, etc.).
 * - A key resolution mismatch (wrong deployment, missing key material).
 * - A malformed encrypted envelope (too short to contain the GCM nonce
 *   and tag).
 *
 * Extends {@link WorkflowRuntimeError} so the run-failure classifier
 * routes it to `RUNTIME_ERROR`.
 */
export class RuntimeDecryptionError extends WorkflowRuntimeError {
  /** Optional structured context about the failed encrypt/decrypt call. */
  readonly context?: RuntimeDecryptionErrorContext;

  constructor(
    message: string,
    options?: ErrorOptions & { context?: RuntimeDecryptionErrorContext }
  ) {
    super(message, {
      cause: options?.cause,
      slug: ERROR_SLUGS.RUNTIME_DECRYPTION_FAILED,
    });
    this.name = 'RuntimeDecryptionError';
    if (options?.context !== undefined) {
      this.context = options.context;
    }
  }

  static is(value: unknown): value is RuntimeDecryptionError {
    return isError(value) && value.name === 'RuntimeDecryptionError';
  }
}

interface WorkflowBuildErrorOptions extends ErrorOptions {
  /**
   * An optional actionable hint appended to the main message, explaining how
   * the user can resolve the failure. Shown after a blank line.
   */
  hint?: string;
}

/**
 * Thrown when the workflow build pipeline (esbuild, SWC transform, file
 * discovery, bundler integration) fails in a way the user can act on.
 *
 * This is distinct from `WorkflowRuntimeError` (which is raised at runtime
 * by the workflow engine) — `WorkflowBuildError` fires during `pnpm build`,
 * `next build`, or equivalent, before any workflow has started executing.
 *
 * Prefer attaching a short, actionable `hint` (e.g. `run \`pnpm install workflow\``)
 * as plain text — the rendering layer is responsible for any styling or
 * "hint:" label. Keeping `hint` plain keeps it useful in non-TTY contexts
 * (CI logs, structured error serialization) where ANSI escapes are noise.
 */
export class WorkflowBuildError extends WorkflowError {
  readonly hint?: string;

  constructor(message: string, options?: WorkflowBuildErrorOptions) {
    // Pass `hint` framed alongside the title so `WorkflowError`'s
    // constructor sees a complete `${title}\n├▶ hint: …` body before
    // it appends the `╰▶ docs: …` line. Build errors don't carry a
    // slug today, but this keeps the layout consistent if one is
    // added later.
    const body = appendFramedDetails(
      message,
      buildFramedDetails(options?.hint, undefined)
    );
    super(body, { cause: options?.cause });
    this.name = 'WorkflowBuildError';
    this.hint = options?.hint;
  }

  static is(value: unknown): value is WorkflowBuildError {
    return isError(value) && value.name === 'WorkflowBuildError';
  }
}

interface SerializationErrorOptions extends ErrorOptions {
  /**
   * An optional actionable hint appended to the main message, explaining how
   * the user can resolve the failure (e.g. "register the class with…" or
   * "move this call inside a step").
   */
  hint?: string;
}

/**
 * Thrown when a value cannot be serialized into or deserialized out of the
 * workflow event log.
 *
 * This usually indicates a user-facing mistake: passing a non-serializable
 * value (class without `WORKFLOW_SERIALIZE`, locked stream, direct workflow
 * function reference) into a step boundary, or an unregistered class
 * returning from a step.
 *
 * Internal invariants (corrupted buffers, unknown format bytes) should use
 * `WorkflowRuntimeError` instead — this class is scoped to things the user
 * can fix in their own code.
 */
export class SerializationError extends WorkflowError {
  readonly hint?: string;
  /**
   * Serialization errors are deterministic — if a step returns a non-POJO,
   * replaying the step will always produce the same non-serializable value.
   * Retrying is guaranteed to fail, so these errors are surfaced as fatal
   * and skip the step-retry loop. `FatalError.is()` recognizes any error
   * with `fatal: true` (see `packages/errors/src/index.ts`), so no other
   * wiring is required for user-thrown SerializationErrors.
   */
  readonly fatal = true;

  constructor(message: string, options?: SerializationErrorOptions) {
    // The hint carries its own docs URL (pointing at the foundations
    // serialization page, which is what users actually need to see what
    // round-trips), so we don't add a separate `╰▶ docs:` line here.
    // Avoids two URLs on the message — one already-actionable, the other
    // pointing at a generic error explainer.
    const body = appendFramedDetails(
      message,
      buildFramedDetails(options?.hint, undefined)
    );
    super(body, { cause: options?.cause });
    this.name = 'SerializationError';
    this.hint = options?.hint;
  }

  static is(value: unknown): value is SerializationError {
    return isError(value) && value.name === 'SerializationError';
  }
}

/**
 * Thrown when a step function is not registered in the current deployment.
 *
 * This is an infrastructure error — not a user code error. It typically means
 * something went wrong with the bundling/build tooling that caused the step
 * to not get built correctly.
 *
 * When this happens, the step fails (like a FatalError) and control is passed back
 * to the workflow function, which can optionally handle the failure gracefully.
 */
export class StepNotRegisteredError extends WorkflowRuntimeError {
  stepName: string;

  constructor(stepName: string) {
    super(
      `Step "${stepName}" is not registered in the current deployment. This usually indicates a build or bundling issue that caused the step to not be included in the deployment.`,
      { slug: ERROR_SLUGS.STEP_NOT_REGISTERED }
    );
    this.name = 'StepNotRegisteredError';
    this.stepName = stepName;
  }

  static is(value: unknown): value is StepNotRegisteredError {
    return isError(value) && value.name === 'StepNotRegisteredError';
  }
}

/**
 * Thrown when a workflow function is not registered in the current deployment.
 *
 * This is an infrastructure error — not a user code error. It typically means:
 * - A run was started against a deployment that does not have the workflow
 *   (e.g., the workflow was renamed or moved and a new run targeted the latest deployment)
 * - Something went wrong with the bundling/build tooling that caused the workflow
 *   to not get built correctly
 *
 * When this happens, the run fails with a `RUNTIME_ERROR` error code.
 */
export class WorkflowNotRegisteredError extends WorkflowRuntimeError {
  workflowName: string;

  constructor(workflowName: string) {
    super(
      `Workflow "${workflowName}" is not registered in the current deployment. This usually means a run was started against a deployment that does not have this workflow, or there was a build/bundling issue.`,
      { slug: ERROR_SLUGS.WORKFLOW_NOT_REGISTERED }
    );
    this.name = 'WorkflowNotRegisteredError';
    this.workflowName = workflowName;
  }

  static is(value: unknown): value is WorkflowNotRegisteredError {
    return isError(value) && value.name === 'WorkflowNotRegisteredError';
  }
}

/**
 * Thrown when performing operations on a workflow run that does not exist.
 *
 * This error occurs when you call methods on a run object (e.g. `run.status`,
 * `run.cancel()`, `run.returnValue`) but the underlying run ID does not match
 * any known workflow run. Note that `getRun(id)` itself is synchronous and will
 * not throw — this error is raised when subsequent operations discover the run
 * is missing.
 *
 * Use the static `WorkflowRunNotFoundError.is()` method for type-safe checking
 * in catch blocks.
 *
 * @example
 * ```ts
 * import { WorkflowRunNotFoundError } from "workflow/internal/errors";
 *
 * try {
 *   const status = await run.status;
 * } catch (error) {
 *   if (WorkflowRunNotFoundError.is(error)) {
 *     console.error(`Run ${error.runId} does not exist`);
 *   }
 * }
 * ```
 */
export class WorkflowRunNotFoundError extends WorkflowError {
  runId: string;

  constructor(runId: string) {
    super(`Workflow run "${runId}" not found`, {});
    this.name = 'WorkflowRunNotFoundError';
    this.runId = runId;
  }

  static is(value: unknown): value is WorkflowRunNotFoundError {
    return isError(value) && value.name === 'WorkflowRunNotFoundError';
  }
}

/**
 * Thrown when a hook token is already in use by another active workflow run.
 *
 * This is a user error — it means the same custom token was passed to
 * `createHook` in two or more concurrent runs. Use a unique token per run
 * (or omit the token to let the runtime generate one automatically).
 */
export class HookConflictError extends WorkflowError {
  token: string;
  // TODO: Make this required once all persisted hook_conflict events and World
  // implementations always include the active hook owner's run ID.
  conflictingRunId?: string;

  constructor(token: string, conflictingRunId?: string) {
    super(
      `Hook token "${token}" is already in use by another workflow${conflictingRunId ? ` (run "${conflictingRunId}")` : ''}`,
      {
        slug: ERROR_SLUGS.HOOK_CONFLICT,
      }
    );
    this.name = 'HookConflictError';
    this.token = token;
    if (conflictingRunId !== undefined) {
      this.conflictingRunId = conflictingRunId;
    }
  }

  static is(value: unknown): value is HookConflictError {
    return isError(value) && value.name === 'HookConflictError';
  }
}

/**
 * Thrown when calling `resumeHook()` or `resumeWebhook()` with a token that
 * does not match any active hook.
 *
 * Common causes:
 * - The hook has expired (past its TTL)
 * - The hook was already disposed after being consumed
 * - The workflow has not started yet, so the hook does not exist
 *
 * A common pattern is to catch this error and start a new workflow run when
 * the hook does not exist yet (the "resume or start" pattern).
 *
 * Use the static `HookNotFoundError.is()` method for type-safe checking in
 * catch blocks.
 *
 * @example
 * ```ts
 * import { HookNotFoundError } from "workflow/internal/errors";
 *
 * try {
 *   await resumeHook(token, payload);
 * } catch (error) {
 *   if (HookNotFoundError.is(error)) {
 *     // Hook doesn't exist — start a new workflow run instead
 *     await startWorkflow("myWorkflow", payload);
 *   }
 * }
 * ```
 */
export class HookNotFoundError extends WorkflowError {
  token: string;

  constructor(token: string) {
    super('Hook not found', {});
    this.name = 'HookNotFoundError';
    this.token = token;
  }

  static is(value: unknown): value is HookNotFoundError {
    return isError(value) && value.name === 'HookNotFoundError';
  }
}

/**
 * Thrown when an operation conflicts with the current state of an entity.
 * This includes attempts to modify an entity already in a terminal state,
 * create an entity that already exists, or any other 409-style conflict.
 *
 * The workflow runtime handles this error automatically. Users interacting
 * with world storage backends directly may encounter it.
 */
export class EntityConflictError extends WorkflowWorldError {
  constructor(message: string) {
    super(message);
    this.name = 'EntityConflictError';
  }

  static is(value: unknown): value is EntityConflictError {
    return isError(value) && value.name === 'EntityConflictError';
  }
}

/**
 * Thrown when a run is no longer available — either because it has been
 * cleaned up, expired, or already reached a terminal state (completed/failed).
 *
 * The workflow runtime handles this error automatically. Users interacting
 * with world storage backends directly may encounter it.
 */
export class RunExpiredError extends WorkflowWorldError {
  constructor(message: string) {
    super(message);
    this.name = 'RunExpiredError';
  }

  static is(value: unknown): value is RunExpiredError {
    return isError(value) && value.name === 'RunExpiredError';
  }
}

/**
 * Thrown when an operation cannot proceed because a required timestamp
 * (e.g. retryAfter) has not been reached yet.
 *
 * The workflow runtime handles this error automatically. Users interacting
 * with world storage backends directly may encounter it.
 *
 * @property retryAfter - Delay in seconds before the operation can be retried.
 */
export class TooEarlyError extends WorkflowWorldError {
  constructor(message: string, options?: { retryAfter?: number }) {
    super(message, { retryAfter: options?.retryAfter });
    this.name = 'TooEarlyError';
  }

  static is(value: unknown): value is TooEarlyError {
    return isError(value) && value.name === 'TooEarlyError';
  }
}

/**
 * Thrown when a request is rate limited by the workflow backend.
 *
 * The workflow runtime handles this error automatically with retry logic.
 * Users interacting with world storage backends directly may encounter it
 * if retries are exhausted.
 *
 * @property retryAfter - Delay in seconds before the request can be retried.
 */
export class ThrottleError extends WorkflowWorldError {
  retryAfter?: number;

  constructor(message: string, options?: { retryAfter?: number }) {
    super(message);
    this.name = 'ThrottleError';
    this.retryAfter = options?.retryAfter;
  }

  static is(value: unknown): value is ThrottleError {
    return isError(value) && value.name === 'ThrottleError';
  }
}

/**
 * Thrown when awaiting `run.returnValue` on a workflow run that was cancelled.
 *
 * This error indicates that the workflow was explicitly cancelled (via
 * `run.cancel()`) and will not produce a return value. You can check for
 * cancellation before awaiting the return value by inspecting `run.status`.
 *
 * Use the static `WorkflowRunCancelledError.is()` method for type-safe
 * checking in catch blocks.
 *
 * @example
 * ```ts
 * import { WorkflowRunCancelledError } from "workflow/internal/errors";
 *
 * try {
 *   const result = await run.returnValue;
 * } catch (error) {
 *   if (WorkflowRunCancelledError.is(error)) {
 *     console.log(`Run ${error.runId} was cancelled`);
 *   }
 * }
 * ```
 */
export class WorkflowRunCancelledError extends WorkflowError {
  runId: string;

  constructor(runId: string) {
    super(`Workflow run "${runId}" cancelled`, {});
    this.name = 'WorkflowRunCancelledError';
    this.runId = runId;
  }

  static is(value: unknown): value is WorkflowRunCancelledError {
    return isError(value) && value.name === 'WorkflowRunCancelledError';
  }
}

/**
 * Thrown when attempting to operate on a workflow run that requires a newer World version.
 *
 * This error occurs when a run was created with a newer spec version than the
 * current World implementation supports. To resolve this, upgrade your
 * `workflow` packages to a version that supports the required spec version.
 *
 * Use the static `RunNotSupportedError.is()` method for type-safe checking in
 * catch blocks.
 *
 * @example
 * ```ts
 * import { RunNotSupportedError } from "workflow/internal/errors";
 *
 * try {
 *   const status = await run.status;
 * } catch (error) {
 *   if (RunNotSupportedError.is(error)) {
 *     console.error(
 *       `Run requires spec v${error.runSpecVersion}, ` +
 *       `but world supports v${error.worldSpecVersion}`
 *     );
 *   }
 * }
 * ```
 */
export class RunNotSupportedError extends WorkflowError {
  readonly runSpecVersion: number;
  readonly worldSpecVersion: number;

  constructor(runSpecVersion: number, worldSpecVersion: number) {
    super(
      `Run requires spec version ${runSpecVersion}, but world supports version ${worldSpecVersion}. ` +
        `Please upgrade 'workflow' package.`
    );
    this.name = 'RunNotSupportedError';
    this.runSpecVersion = runSpecVersion;
    this.worldSpecVersion = worldSpecVersion;
  }

  static is(value: unknown): value is RunNotSupportedError {
    return isError(value) && value.name === 'RunNotSupportedError';
  }
}

/**
 * A fatal error is an error that cannot be retried.
 * It will cause the step to fail and the error will
 * be bubbled up to the workflow logic.
 *
 * Any error can opt into the non-retry behavior by setting a `fatal: true`
 * own property. This is how structured error classes that aren't direct
 * `FatalError` subclasses (e.g. context-violation errors) signal to the
 * step handler that retrying will never help — the user's code is calling
 * a workflow-only API from the wrong context, or similar — and burning
 * retry attempts just produces a wall of duplicated log output.
 */
export class FatalError extends Error {
  fatal = true;

  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }

  static is(value: unknown): value is FatalError {
    if (!isError(value)) return false;
    if (value.name === 'FatalError') return true;
    return (value as { fatal?: unknown }).fatal === true;
  }
}

export interface RetryableErrorOptions {
  /**
   * The number of milliseconds to wait before retrying the step.
   * Can also be a duration string (e.g., "5s", "2m") or a Date object.
   * If not provided, the step will be retried after 1 second (1000 milliseconds).
   */
  retryAfter?: number | StringValue | Date;
}

/**
 * An error that can happen during a step execution, allowing
 * for configuration of the retry behavior.
 */
export class RetryableError extends Error {
  /**
   * The Date when the step should be retried.
   */
  retryAfter: Date;

  constructor(message: string, options: RetryableErrorOptions = {}) {
    super(message);
    this.name = 'RetryableError';

    if (options.retryAfter !== undefined) {
      this.retryAfter = parseDurationToDate(options.retryAfter);
    } else {
      // Default to 1 second (1000 milliseconds)
      this.retryAfter = new Date(Date.now() + 1000);
    }
  }

  static is(value: unknown): value is RetryableError {
    return isError(value) && value.name === 'RetryableError';
  }
}

export const VERCEL_403_ERROR_MESSAGE =
  'Your current vercel account does not have access to this resource. Use `vercel login` or `vercel switch` to ensure you are linked to the right account.';

export { RUN_ERROR_CODES, type RunErrorCode } from './error-codes.js';

// ---------------------------------------------------------------------------
// Cross-realm class registration
// ---------------------------------------------------------------------------
//
// `FatalError`, `RetryableError`, and `HookConflictError` are not built-ins, so different realms
// (e.g. the workflow VM context vs. the host context that runs the queue
// handler) bundle and load their own copies of this module — meaning each
// realm has its own distinct class identity. Cross-realm `instanceof` fails
// because the prototype chains never meet.
//
// To let serialization revivers reconstruct a value as the *consumer's*
// FatalError (so user-code `err instanceof FatalError` passes), each bundled
// copy of this module self-registers its class on `globalThis` via a known
// Symbol.for key. Revivers in `@workflow/core` look up the class via the
// consumer's globalThis at hydration time.
//
// First registration in a given realm wins. The descriptor is non-writable
// and non-configurable to make accidental clobbering loud.
const FATAL_ERROR_KEY = Symbol.for('@workflow/errors//FatalError');
const RETRYABLE_ERROR_KEY = Symbol.for('@workflow/errors//RetryableError');
const HOOK_CONFLICT_ERROR_KEY = Symbol.for(
  '@workflow/errors//HookConflictError'
);
const RUNTIME_DECRYPTION_ERROR_KEY = Symbol.for(
  '@workflow/errors//RuntimeDecryptionError'
);

if (typeof globalThis !== 'undefined') {
  if (!Object.hasOwn(globalThis, FATAL_ERROR_KEY)) {
    Object.defineProperty(globalThis, FATAL_ERROR_KEY, {
      value: FatalError,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  if (!Object.hasOwn(globalThis, RETRYABLE_ERROR_KEY)) {
    Object.defineProperty(globalThis, RETRYABLE_ERROR_KEY, {
      value: RetryableError,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  if (!Object.hasOwn(globalThis, HOOK_CONFLICT_ERROR_KEY)) {
    Object.defineProperty(globalThis, HOOK_CONFLICT_ERROR_KEY, {
      value: HookConflictError,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  if (!Object.hasOwn(globalThis, RUNTIME_DECRYPTION_ERROR_KEY)) {
    Object.defineProperty(globalThis, RUNTIME_DECRYPTION_ERROR_KEY, {
      value: RuntimeDecryptionError,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}
