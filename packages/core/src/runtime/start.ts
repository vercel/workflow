import { waitUntil } from '@vercel/functions';
import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { WorkflowInvokePayload } from '@workflow/world';
import { Run } from '../runtime.js';
import type { Serializable } from '../schemas.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { serializeTraceCarrier, trace } from '../telemetry.js';
import { waitedUntil } from '../util.js';
import { getWorld } from './world.js';

export interface StartOptions {
  /**
   * The deployment ID to use for the workflow run.
   *
   * @deprecated This property should not be set in user code under normal circumstances.
   * It is automatically inferred from environment variables when deploying to Vercel.
   * Only set this if you are doing something advanced and know what you are doing.
   */
  deploymentId?: string;
}

/**
 * Represents an imported workflow function.
 */
export type WorkflowFunction<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult>;

/**
 * Represents the generated metadata of a workflow function.
 */
export type WorkflowMetadata = { workflowId: string };

/**
 * Starts a workflow run.
 *
 * @param workflow - The imported workflow function to start.
 * @param args - The arguments to pass to the workflow (optional).
 * @param options - The options for the workflow run (optional).
 * @returns The unique run ID for the newly started workflow invocation.
 */
export function start<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  options?: StartOptions
): Promise<Run<TResult>>;

export function start<TResult>(
  workflow: WorkflowFunction<[], TResult> | WorkflowMetadata,
  options?: StartOptions
): Promise<Run<TResult>>;

export async function start<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  argsOrOptions?: TArgs | StartOptions,
  options?: StartOptions
) {
  return await waitedUntil(() => {
    // @ts-expect-error this field is added by our client transform
    const workflowName = workflow?.workflowId;

    if (!workflowName) {
      throw new WorkflowRuntimeError(
        `'start' received an invalid workflow function. Ensure the Workflow Development Kit is configured correctly and the function includes a 'use workflow' directive.`,
        { slug: 'start-invalid-workflow-function' }
      );
    }

    return trace(`WORKFLOW.start ${workflowName}`, async (span) => {
      span?.setAttributes({
        ...Attribute.WorkflowName(workflowName),
        ...Attribute.WorkflowOperation('start'),
      });

      let args: Serializable[] = [];
      let opts: StartOptions = options ?? {};
      if (Array.isArray(argsOrOptions)) {
        args = argsOrOptions as Serializable[];
      } else if (typeof argsOrOptions === 'object') {
        opts = argsOrOptions;
      }

      span?.setAttributes({
        ...Attribute.WorkflowArgumentsCount(args.length),
      });

      const world = getWorld();
      const deploymentId = opts.deploymentId ?? (await world.getDeploymentId());
      const ops: Promise<void>[] = [];
      const { promise: runIdPromise, resolve: resolveRunId } =
        withResolvers<string>();

      const workflowArguments = dehydrateWorkflowArguments(
        args,
        ops,
        runIdPromise
      );
      // Serialize current trace context to propagate across queue boundary
      const traceCarrier = await serializeTraceCarrier();

      const runResponse = await world.runs.create({
        deploymentId: deploymentId,
        workflowName: workflowName,
        input: workflowArguments,
        executionContext: { traceCarrier },
      });

      resolveRunId(runResponse.runId);

      waitUntil(
        Promise.all(ops).catch((err) => {
          // Ignore expected client disconnect errors (e.g., browser refresh during streaming)
          const isAbortError =
            err?.name === 'AbortError' || err?.name === 'ResponseAborted';
          if (!isAbortError) throw err;
        })
      );

      span?.setAttributes({
        ...Attribute.WorkflowRunId(runResponse.runId),
        ...Attribute.WorkflowRunStatus(runResponse.status),
        ...Attribute.DeploymentId(deploymentId),
      });

      await world.queue(
        `__wkf_workflow_${workflowName}`,
        {
          runId: runResponse.runId,
          traceCarrier,
        } satisfies WorkflowInvokePayload,
        {
          deploymentId,
        }
      );

      return new Run<TResult>(runResponse.runId);
    });
  });
}
