/** Options `new AbortController(options)` takes in workflow code. */
export interface WorkflowAbortControllerOptions {
  /**
   * Only workflow code aborts this controller, and steps only receive its
   * `signal`. An open in-band-only controller doesn't stop run-ahead, and
   * passing the controller itself to a step throws a `SerializationError`.
   * Ignored under `WORKFLOW_VM=quickjs`.
   */
  inBandOnly?: boolean;
}

/**
 * The `AbortController` constructor in workflow code, typed with the options
 * it takes. The DOM and Node.js types declare a constructor without
 * arguments, so cast the global to this type inside the workflow function to
 * pass options:
 *
 * ```ts
 * const InBandOnlyAbortController =
 *   AbortController as WorkflowAbortControllerConstructor;
 * const controller = new InBandOnlyAbortController({ inBandOnly: true });
 * ```
 */
export type WorkflowAbortControllerConstructor = new (
  options?: WorkflowAbortControllerOptions
) => AbortController;
