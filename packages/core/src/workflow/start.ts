import type { WorkflowOrchestratorContext } from '../private.js';
import type { Serializable } from '../schemas.js';
import { createUseStep } from '../step.js';

export function createStart(ctx: WorkflowOrchestratorContext) {
  const internalStartStep = createUseStep(ctx)<
    [string, Serializable[], Serializable],
    string
  >('__workflow_start');

  return async function startImpl(
    workflow: { workflowId?: string } | ((...args: any[]) => any),
    argsOrOptions?: unknown[] | Record<string, unknown>,
    options?: Record<string, unknown>
  ) {
    // Extract workflowId the same way as the real start()
    // @ts-expect-error - workflowId is added by the client transform
    const workflowId = workflow?.workflowId;

    if (!workflowId) {
      throw new Error(
        `'start' received an invalid workflow function. Ensure the Workflow Development Kit is configured correctly and the function includes a 'use workflow' directive.`
      );
    }

    // Parse overloaded args/options (same pattern as real start)
    let args: Serializable[] = [];
    let opts: Serializable = (options ?? {}) as Serializable;
    if (Array.isArray(argsOrOptions)) {
      args = argsOrOptions as Serializable[];
    } else if (typeof argsOrOptions === 'object' && argsOrOptions !== null) {
      opts = argsOrOptions as Serializable;
    }

    const runId = await internalStartStep(workflowId, args, opts);
    return { runId };
  };
}
