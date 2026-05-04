import { redirectStackToCaller } from './capture-stack.js';
import {
  ContextViolationError,
  type Detail,
  type DocsUrl,
  NotInStepContextError,
  NotInWorkflowContextError,
  NotInWorkflowOrStepContextError,
} from './context-violation-error.js';
import {
  WORKFLOW_CONTEXT_SYMBOL,
  type WorkflowMetadata,
} from './workflow/get-workflow-metadata.js';

// Re-export the structural base + subclasses so the public surface is a
// single import point. The base + simpler subclasses live in
// `context-violation-error.ts` because `get-workflow-metadata.ts` needs to
// throw one without creating an import cycle with this file.
export {
  ContextViolationError,
  NotInStepContextError,
  NotInWorkflowContextError,
  NotInWorkflowOrStepContextError,
};

/**
 * Thrown when an API that MUST NOT run inside a workflow function is called
 * from one (e.g. `resumeHook()`, which would cause determinism issues).
 * The message names the specific workflow that made the offending call.
 */
export class UnavailableInWorkflowContextError extends ContextViolationError {
  name = 'UnavailableInWorkflowContextError';

  constructor(functionName: string, docsUrl: DocsUrl) {
    const ctx = (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] as
      | WorkflowMetadata
      | undefined;
    const workflowName = ctx?.workflowName;

    // Apply dim styling to `workflow/` / `step/` prefixes in the qualified
    // name so the part the user named stands out.
    const nameSegs = (() => {
      if (!workflowName) return null;
      const m = workflowName.match(/^(workflow\/|step\/)(.*)$/);
      if (m) return [{ dim: m[1] }, { text: m[2] }] as const;
      return [{ text: workflowName }] as const;
    })();

    const contextLine: Detail = nameSegs
      ? {
          type: 'plain',
          segments: [
            { text: 'this call was made from the ' },
            ...nameSegs,
            { text: ' workflow context.' },
          ],
        }
      : {
          type: 'plain',
          segments: [{ text: 'this call was made from a workflow context.' }],
        };

    super({
      title: [
        { code: functionName },
        { text: ' cannot be called from a workflow context.' },
      ],
      details: [
        {
          type: 'plain',
          segments: [
            {
              text: 'calling this in a workflow context can cause determinism issues.',
            },
          ],
        },
        contextLine,
        { type: 'docs', url: docsUrl },
      ],
    });
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
  // biome-ignore lint/complexity/noBannedTypes: matches Error.captureStackTrace
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
  // biome-ignore lint/complexity/noBannedTypes: matches Error.captureStackTrace
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
  // biome-ignore lint/complexity/noBannedTypes: matches Error.captureStackTrace
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
  // biome-ignore lint/complexity/noBannedTypes: matches Error.captureStackTrace
  stackStartFn: Function
): never {
  const err = new UnavailableInWorkflowContextError(functionName, docsUrl);
  redirectStackToCaller(err, stackStartFn);
  throw err;
}
