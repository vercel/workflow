import { HookConflictError } from '@workflow/errors';
import {
  type ScheduleDeliveryPayload,
  ScheduleDeliveryPayloadSchema,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import {
  decodeScheduleTopicSuffix,
  SCHEDULE_TOPIC_MARKER,
  scheduleTopicForWorkflowName,
} from '../schedule-topic.js';
import { getMaxQueueDeliveries } from './constants.js';
import {
  start,
  type WorkflowFunction,
  type WorkflowMetadata,
} from './start.js';

/**
 * Starting a workflow straight from a Vercel Schedule.
 *
 * A schedule with a queue topic target publishes one message per occurrence.
 * When that topic is a workflow's schedule topic ({@link scheduleTopic}), the
 * workflow's own flow route, which already consumes every `__wkf_workflow_*`
 * topic, receives the message and starts the workflow with it. There is no
 * route or queue consumer of the app's in between.
 *
 * The workflow is called with one argument, the occurrence as a
 * {@link ScheduledRun}. Each occurrence starts at most one run: the start is
 * keyed by the occurrence's `executionId` (`start({ experimental_hook })`), so
 * a redelivered message finds the run it already started.
 */

/** How long an occurrence's start token outlives its run: past any redelivery of its message. */
const SCHEDULE_START_TOKEN_RETENTION = '7 days';

/**
 * A static schedule for a workflow, set at the top level of the workflow's
 * file. The build reads it and emits a Vercel Schedule that starts the
 * workflow, so the workflow needs no entry in `vercel.json`:
 *
 * ```ts
 * export async function nightlyReport(run: ScheduledRun) {
 *   'use workflow';
 *   // ...
 * }
 * nightlyReport.experimental_schedule = {
 *   cron: '0 2 * * *',
 *   timezone: 'America/New_York',
 * } satisfies WorkflowSchedule;
 * ```
 *
 * Set an array for several schedules; each then needs a `name`. The value
 * must be a literal: the build reads it without running the file.
 */
export interface WorkflowSchedule {
  /** Five-field cron expression, evaluated in `timezone`. */
  cron: string;
  /** IANA timezone, such as `America/New_York`. Defaults to UTC. */
  timezone?: string;
  /** Jitter window in whole minutes, from 1 to 15. */
  jitter?: number;
  /**
   * The schedule's name in the deployment. Defaults to the workflow's export
   * name. Names identify a schedule across deployments, so keep them stable.
   */
  name?: string;
}

/**
 * A JSON value: what a schedule's payload can hold, since Vercel Schedules
 * stores it as JSON.
 */
export type ScheduleJsonValue =
  | string
  | number
  | boolean
  | null
  | ScheduleJsonValue[]
  | { [key: string]: ScheduleJsonValue };

/**
 * The argument a workflow started by a schedule receives: the occurrence the
 * schedule fired for, as Vercel Schedules describes it.
 *
 * @typeParam TPayload - The dynamic schedule's payload, set with
 * {@link scheduleTarget}. Static schedules have none.
 */
export interface ScheduledRun<
  TPayload extends ScheduleJsonValue | undefined = undefined,
> {
  /** ID of the schedule. */
  scheduleId: string;
  /**
   * ID of this occurrence. Every delivery of the occurrence carries the same
   * one, and it starts at most one run.
   */
  executionId: string;
  /** The schedule's name. */
  name: string;
  /** The schedule's namespace. Static schedules use `default`. */
  namespace: string;
  /** When the schedule's expression matched. It doesn't include jitter, so the run can start later. */
  scheduledAt: Date;
  /** `static` for a schedule in `vercel.json`, `dynamic` for one created at runtime. */
  source: 'static' | 'dynamic';
  /** The cron expression, or the local datetime of a one-time schedule, when Vercel sends it. */
  expression?: string;
  /** The dynamic schedule's payload. `undefined` for a static schedule. */
  payload: TPayload;
}

type ScheduledWorkflow<TPayload extends ScheduleJsonValue | undefined> = (
  run: ScheduledRun<TPayload>
) => Promise<unknown>;

/**
 * The Vercel Queues topic that starts `workflow` when a schedule publishes to
 * it. Use it as a static schedule's `topic` in `vercel.json`, or a dynamic
 * schedule's `target.topic` (or spread {@link scheduleTarget}, which also types
 * the payload).
 *
 * The topic is derived from the workflow's name, the same on every deployment
 * and build, so it can be written in `vercel.json`.
 *
 * @example
 * ```ts
 * scheduleTopic(nightlyReport);
 * // '__wkf_workflow_schedule_workflows_snightly-report__nightlyReport'
 * ```
 */
export function scheduleTopic(
  // Any workflow can be started by a static schedule.
  workflow: WorkflowFunction<any[], unknown> | WorkflowMetadata,
  options?: { namespace?: string }
): string {
  const workflowName = (workflow as Partial<WorkflowMetadata> | undefined)
    ?.workflowId;
  if (typeof workflowName !== 'string' || !workflowName) {
    throw new Error(
      `'scheduleTopic' received an invalid workflow function. Ensure the Workflow SDK is configured correctly and the function includes a 'use workflow' directive.`
    );
  }
  return scheduleTopicForWorkflowName(workflowName, options?.namespace);
}

/**
 * The `target` (and `payload`) of a dynamic schedule that starts `workflow`,
 * to spread into `Schedules.create()` or `Schedules.update()` from
 * `@vercel/schedules`. The payload is type-checked against the workflow's
 * {@link ScheduledRun} parameter.
 *
 * @example
 * ```ts
 * export async function sendDigest(run: ScheduledRun<{ userId: string }>) {
 *   'use workflow';
 *   // ...
 * }
 *
 * await Schedules.create({
 *   name: `digest-${userId}`,
 *   expression: { type: 'cron', cron: '0 9 * * *' },
 *   ...scheduleTarget(sendDigest, { userId }),
 * });
 * ```
 */
export function scheduleTarget<TPayload extends ScheduleJsonValue | undefined>(
  workflow: ScheduledWorkflow<TPayload>,
  ...[payload]: TPayload extends undefined
    ? [payload?: undefined]
    : [payload: TPayload]
): { target: { topic: string }; payload?: TPayload } {
  const target = { topic: scheduleTopic(workflow) };
  return payload === undefined
    ? { target }
    : { target, payload: payload as TPayload };
}

/** A schedule delivery the flow route received, when the message is one. */
export function parseScheduleDelivery(
  message: unknown
): ScheduleDeliveryPayload | undefined {
  const parsed = ScheduleDeliveryPayloadSchema.safeParse(message);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Starts the workflow a schedule topic names for one occurrence, keyed by the
 * occurrence so a redelivery cannot start a second run.
 *
 * Returns normally when the run started, when an earlier delivery already
 * started it, and when the message can never start one (a topic that names no
 * workflow, a delivery past the cap); it throws only for a failure the queue
 * should retry, which redelivers the message with the same key.
 */
export async function handleScheduleDelivery(
  delivery: ScheduleDeliveryPayload,
  context: { queueName: string; workflowPrefix: string; attempt: number }
): Promise<void> {
  const { queueName, workflowPrefix, attempt } = context;
  const suffix = queueName.slice(workflowPrefix.length);
  const workflowName = suffix.startsWith(SCHEDULE_TOPIC_MARKER)
    ? decodeScheduleTopicSuffix(suffix.slice(SCHEDULE_TOPIC_MARKER.length))
    : undefined;
  const logContext = {
    scheduleName: delivery.name,
    scheduleNamespace: delivery.namespace,
    executionId: delivery.executionId,
    queueName,
  };
  if (!workflowName) {
    runtimeLogger.error(
      'A schedule published to a topic that names no workflow, so no run was started. Set the schedule\'s topic with scheduleTopic() from "workflow/api".',
      logContext
    );
    return;
  }
  const maxDeliveries = getMaxQueueDeliveries();
  if (attempt > maxDeliveries) {
    runtimeLogger.error(
      `A schedule's run of "${workflowName}" could not be started after ${attempt - 1} deliveries; the occurrence is skipped.`,
      { ...logContext, workflowName }
    );
    return;
  }

  const run: ScheduledRun<ScheduleJsonValue | undefined> = {
    scheduleId: delivery.scheduleId,
    executionId: delivery.executionId,
    name: delivery.name,
    namespace: delivery.namespace,
    scheduledAt: new Date(delivery.scheduledAt),
    source: delivery.source === 'dynamic' ? 'dynamic' : 'static',
    ...(delivery.expression !== undefined
      ? { expression: delivery.expression }
      : {}),
    payload: delivery.payload as ScheduleJsonValue | undefined,
  };
  try {
    const started = await start({ workflowId: workflowName }, [run], {
      experimental_hook: {
        token: scheduleStartToken(delivery),
        experimental_minRetention: SCHEDULE_START_TOKEN_RETENTION,
      },
    });
    runtimeLogger.info(`Started "${workflowName}" for a schedule`, {
      ...logContext,
      workflowName,
      workflowRunId: started.runId,
    });
  } catch (err) {
    if (HookConflictError.is(err)) {
      // An earlier delivery of this occurrence started the run.
      return;
    }
    throw err;
  }
}

/** The start token of one occurrence: the schedule and its execution. */
export function scheduleStartToken(
  delivery: Pick<ScheduleDeliveryPayload, 'scheduleId' | 'executionId'>
): string {
  return `schedule:${delivery.scheduleId}:${delivery.executionId}`;
}

export {
  decodeScheduleTopicSuffix,
  encodeScheduleTopicSuffix,
} from '../schedule-topic.js';
