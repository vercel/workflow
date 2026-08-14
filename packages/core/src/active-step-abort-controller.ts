import { throwNotInWorkflowContext } from './context-errors.js';
import { WORKFLOW_CREATE_ACTIVE_STEP_ABORT_CONTROLLER } from './symbols.js';

/** A workflow-only abort controller whose deterministic token can be resumed while a step is active. */
export interface ActiveStepAbortController {
  readonly signal: AbortSignal;
  readonly token: string;
  dispose(): void;
}

export interface ActiveStepAbortControllerOptions {
  /** A deterministic, non-empty token in the reserved `abrt_` namespace. */
  token: string;
}

type ActiveStepAbortControllerFactory = (
  options: ActiveStepAbortControllerOptions
) => ActiveStepAbortController;

/**
 * Creates a stream-backed cancellation signal for an active workflow step.
 * Resume `token` with `resumeHook()` to abort the signal immediately while
 * still recording the normal durable hook receipt for replay.
 */
export function createActiveStepAbortController(
  options: ActiveStepAbortControllerOptions
): ActiveStepAbortController {
  if (!options.token.startsWith('abrt_') || options.token.length === 5) {
    throw new Error(
      'createActiveStepAbortController() requires a non-empty token beginning with "abrt_"'
    );
  }
  const factory = (globalThis as Record<PropertyKey, unknown>)[
    WORKFLOW_CREATE_ACTIVE_STEP_ABORT_CONTROLLER
  ];
  if (typeof factory !== 'function') {
    throwNotInWorkflowContext(
      'createActiveStepAbortController()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/active-step-abort-controller',
      createActiveStepAbortController
    );
  }
  return (factory as ActiveStepAbortControllerFactory)(options);
}
