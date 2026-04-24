import { Ansi } from '@workflow/errors';
import {
  WORKFLOW_CONTEXT_SYMBOL,
  type WorkflowMetadata,
} from './workflow/get-workflow-metadata.js';

/** A `docs:` line URL. The leading protocol is part of the type so call sites
 * can't accidentally pass a protocol-relative or bare path. */
type DocsUrl = `https://${string}`;

/** Apply dim styling to the `workflow/` / `step/` prefixes in a qualified name. */
function ansifyName(name: string): string {
  return name
    .replace(/^workflow\//, `${Ansi.dim('workflow/')}`)
    .replace(/^step\//, `${Ansi.dim('step/')}`);
}

/**
 * V8-only (Node, Bun, Chrome, Deno). Rewrites `err.stack` so the top frame is
 * the caller of `stackStartFn` instead of the framework function that threw.
 * Without this, terminal overlays (Next.js, Turbopack, VS Code) render the
 * code frame at our `throw` site inside `@workflow/core`, which is useless
 * to the user.
 *
 * No-op on engines that don't expose `Error.captureStackTrace` — the stack
 * degrades gracefully to the default behavior.
 */
function redirectStackToCaller(err: Error, stackStartFn: Function): void {
  const capture = (
    Error as unknown as {
      captureStackTrace?: (target: object, fn: Function) => void;
    }
  ).captureStackTrace;
  capture?.(err, stackStartFn);
}

/**
 * Thrown when an API that must run inside a workflow function is called
 * from outside a workflow context (e.g. from a step function or from
 * regular application code).
 *
 * @example
 * ```
 * `createHook()` can only be called inside a workflow function
 * ╰▶ docs: https://workflow-sdk.dev/docs/...
 * ```
 */
export class NotInWorkflowContextError extends Error {
  name = 'NotInWorkflowContextError';

  constructor(functionName: string, docsUrl: DocsUrl) {
    super(
      Ansi.frame(
        `${Ansi.code(functionName)} can only be called inside a workflow function`,
        [Ansi.docs(docsUrl)]
      )
    );
  }
}

/**
 * Thrown when an API that must run inside a step function is called from
 * outside a step context.
 */
export class NotInStepContextError extends Error {
  name = 'NotInStepContextError';

  constructor(functionName: string, docsUrl: DocsUrl) {
    super(
      Ansi.frame(
        `${Ansi.code(functionName)} can only be called inside a step function`,
        [Ansi.docs(docsUrl)]
      )
    );
  }
}

/**
 * Thrown when an API that must run inside either a workflow or step function
 * is called from regular application code.
 */
export class NotInWorkflowOrStepContextError extends Error {
  name = 'NotInWorkflowOrStepContextError';

  constructor(functionName: string, docsUrl: DocsUrl) {
    super(
      Ansi.frame(
        `${Ansi.code(functionName)} can only be called inside a workflow or step function`,
        [Ansi.docs(docsUrl)]
      )
    );
  }
}

/**
 * Thrown when an API that MUST NOT run inside a workflow function is called
 * from one (e.g. `resumeHook()`, which would cause determinism issues).
 * The message names the specific workflow that made the offending call.
 */
export class UnavailableInWorkflowContextError extends Error {
  name = 'UnavailableInWorkflowContextError';

  constructor(functionName: string, docsUrl: DocsUrl) {
    const ctx = (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] as
      | WorkflowMetadata
      | undefined;
    const workflowName = ctx?.workflowName;

    const contextLine = workflowName
      ? `this call was made from the ${ansifyName(workflowName)} workflow context.`
      : 'this call was made from a workflow context.';

    super(
      Ansi.frame(
        `${Ansi.code(functionName)} cannot be called from a workflow context.`,
        [
          'calling this in a workflow context can cause determinism issues.',
          contextLine,
          Ansi.docs(docsUrl),
        ]
      )
    );
  }
}

/**
 * Throw a {@link NotInWorkflowContextError} whose stack trace points at the
 * user code that called `stackStartFn`, not at our framework internals.
 *
 * Prefer this over `throw new NotInWorkflowContextError(...)` so tooling
 * (Next.js error overlay, VS Code terminal linkifier, Sentry, etc.) shows
 * the user's call site as the relevant frame.
 */
export function throwNotInWorkflowContext(
  functionName: string,
  docsUrl: DocsUrl,
  stackStartFn: Function
): never {
  const err = new NotInWorkflowContextError(functionName, docsUrl);
  redirectStackToCaller(err, stackStartFn);
  throw err;
}

/** See {@link throwNotInWorkflowContext}. */
export function throwNotInStepContext(
  functionName: string,
  docsUrl: DocsUrl,
  stackStartFn: Function
): never {
  const err = new NotInStepContextError(functionName, docsUrl);
  redirectStackToCaller(err, stackStartFn);
  throw err;
}

/** See {@link throwNotInWorkflowContext}. */
export function throwNotInWorkflowOrStepContext(
  functionName: string,
  docsUrl: DocsUrl,
  stackStartFn: Function
): never {
  const err = new NotInWorkflowOrStepContextError(functionName, docsUrl);
  redirectStackToCaller(err, stackStartFn);
  throw err;
}

/** See {@link throwNotInWorkflowContext}. */
export function throwUnavailableInWorkflowContext(
  functionName: string,
  docsUrl: DocsUrl,
  stackStartFn: Function
): never {
  const err = new UnavailableInWorkflowContextError(functionName, docsUrl);
  redirectStackToCaller(err, stackStartFn);
  throw err;
}
