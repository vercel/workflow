import type { WorkflowOrchestratorContext } from '../private.js';
import type { Serializable } from '../schemas.js';
import { createUseStep } from '../step.js';
import { builtinStepId } from './builtin-step-id.js';

const ALLOWED_START_OPTIONS = new Set(['deploymentId', 'specVersion']);

export function createStart(ctx: WorkflowOrchestratorContext) {
  // The step returns a Run object (serialized via the Run reducer to { runId }),
  // which the VM deserializes as a WorkflowRun instance via the Run reviver.
  const internalStartStep = createUseStep(ctx)<
    [string, Serializable[], Serializable],
    // The result type after deserialization in the VM is a WorkflowRun,
    // but from the step's perspective it returns a Run (which serializes to { runId }).
    unknown
  >(builtinStepId('start'));

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

    // Parse overloaded args/options (same pattern as real start),
    // but validate options to ensure they are serializable.
    // The `world` option is not supported in workflow context since World
    // instances are not serializable across the step boundary.
    let args: Serializable[] = [];
    let rawOpts: Record<string, unknown> =
      (options as Record<string, unknown>) ?? {};

    if (Array.isArray(argsOrOptions)) {
      args = argsOrOptions as Serializable[];
    } else if (typeof argsOrOptions === 'object' && argsOrOptions !== null) {
      rawOpts = argsOrOptions as Record<string, unknown>;
    }

    const sanitizedOpts: Record<string, Serializable> = {};
    for (const [key, value] of Object.entries(rawOpts)) {
      if (!ALLOWED_START_OPTIONS.has(key)) {
        throw new Error(
          `Unsupported option '${key}' passed to start() in workflow context. ` +
            `Only 'deploymentId' and 'specVersion' are supported.`
        );
      }
      sanitizedOpts[key] = value as Serializable;
    }

    // The step returns a Run object, which is serialized to { runId } via
    // the Run reducer and deserialized as a WorkflowRun in the VM.
    return await internalStartStep(
      workflowId,
      args,
      sanitizedOpts as Serializable
    );
  };
}
