import { waitUntil } from '@vercel/functions';
import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { WorkflowInvokePayload, World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { Run } from '../runtime.js';
import type { Serializable } from '../schemas.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { serializeTraceCarrier, trace } from '../telemetry.js';
import { waitedUntil } from '../util.js';
import { version as workflowCoreVersion } from '../version.js';
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

  /**
   * The world to use for the workflow run creation,
   * by default the world is inferred from the environment variables.
   */
  world?: World;
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

      const world = opts?.world ?? getWorld();
      const deploymentId = opts.deploymentId ?? (await world.getDeploymentId());
      const ops: Promise<void>[] = [];
      const { promise: runIdPromise, resolve: resolveRunId } =
        withResolvers<string>();

      // Serialize current trace context to propagate across queue boundary
      const traceCarrier = await serializeTraceCarrier();

      // Create run via run_created event (event-sourced architecture)
      // Pass null for runId - the server generates it and returns it in the response
      const workflowArguments = dehydrateWorkflowArguments(
        args,
        ops,
        runIdPromise
      );

      const result = await world.events.create(null, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: deploymentId,
          workflowName: workflowName,
          input: workflowArguments,
          executionContext: { traceCarrier, workflowCoreVersion },
        },
      });

      // Assert that the run was created
      if (!result.run) {
        throw new WorkflowRuntimeError(
          "Missing 'run' in server response for 'run_created' event"
        );
      }

      const runId = result.run.runId;
      resolveRunId(runId);

      waitUntil(
        Promise.all(ops).catch((err) => {
          // Ignore expected client disconnect errors (e.g., browser refresh during streaming)
          const isAbortError =
            err?.name === 'AbortError' || err?.name === 'ResponseAborted';
          if (!isAbortError) throw err;
        })
      );

      span?.setAttributes({
        ...Attribute.WorkflowRunId(runId),
        ...Attribute.WorkflowRunStatus(result.run.status),
        ...Attribute.DeploymentId(deploymentId),
      });

      await world.queue(
        `__wkf_workflow_${workflowName}`,
        {
          runId,
          traceCarrier,
        } satisfies WorkflowInvokePayload,
        {
          deploymentId,
        }
      );

      return new Run<TResult>(runId);
    });
  });
}
