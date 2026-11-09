import { HookConflictError } from '@workflow/errors';
import {
  getQueueTopicPrefix,
  resolveQueueNamespace,
  type ScheduleDeliveryPayload,
  ScheduleDeliveryPayloadSchema,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';
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

/** What follows the queue prefix in every schedule topic. */
const SCHEDULE_TOPIC_MARKER = 'schedule_';

/** Every non-dynamic workflow name starts with it, so the topic leaves it out. */
const WORKFLOW_NAME_PREFIX = 'workflow//';

/** How long an occurrence's start token outlives its run: past any redelivery of its message. */
const SCHEDULE_START_TOKEN_RETENTION = '7 days';

/**
 * Characters a workflow name can hold that a schedule topic cannot. Topics
 * take letters, digits, `_` and `-`; `_` is the escape character, so it is
 * escaped too. `//` (between the module path and the export name) is the
 * common case and gets its own short form.
 */
const ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ['//', '__'],
  ['_', '_u'],
  ['/', '_s'],
  ['.', '_d'],
  ['@', '_a'],
  ['(', '_o'],
  [')', '_c'],
  ['[', '_l'],
  [']', '_r'],
];
const UNESCAPES = new Map(ESCAPES.map(([raw, escaped]) => [escaped[1], raw]));

/**
 * The part of a schedule topic after `schedule_`: the workflow name without
 * its `workflow//` prefix and leading `./`, escaped to the characters a topic
 * allows. `workflow//./src/workflows/report//nightlyReport` becomes
 * `src_sworkflows_sreport__nightlyReport`. A name whose module path does not
 * start with `./` (a workflow from a package) is marked with a leading `_p`.
 * The mapping is reversible ({@link decodeScheduleTopicSuffix}).
 */
export function encodeScheduleTopicSuffix(workflowName: string): string {
  if (!workflowName.startsWith(WORKFLOW_NAME_PREFIX)) {
    throw new Error(
      `Workflow "${workflowName}" cannot be started from a schedule: only workflows compiled into the deployment have a schedule topic.`
    );
  }
  let rest = workflowName.slice(WORKFLOW_NAME_PREFIX.length);
  let marker = '';
  if (rest.startsWith('./')) rest = rest.slice(2);
  else marker = '_p';
  let out = marker;
  for (let i = 0; i < rest.length; ) {
    const match = ESCAPES.find(([raw]) => rest.startsWith(raw, i));
    if (match) {
      out += match[1];
      i += match[0].length;
    } else if (/[A-Za-z0-9-]/.test(rest[i])) {
      out += rest[i];
      i++;
    } else {
      throw new Error(
        `Workflow "${workflowName}" cannot be started from a schedule: its name holds "${rest[i]}", which a schedule topic cannot carry.`
      );
    }
  }
  return out;
}

/** The workflow name a schedule topic suffix encodes, or `undefined` when it encodes none. */
export function decodeScheduleTopicSuffix(suffix: string): string | undefined {
  let rest = suffix;
  let modulePrefix = './';
  if (rest.startsWith('_p')) {
    rest = rest.slice(2);
    modulePrefix = '';
  }
  let out = '';
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '_') {
      const raw = UNESCAPES.get(rest[i + 1]);
      if (raw === undefined) return undefined;
      out += raw;
      i++;
    } else if (/[A-Za-z0-9-]/.test(ch)) {
      out += ch;
    } else {
      return undefined;
    }
  }
  if (!out) return undefined;
  return `${WORKFLOW_NAME_PREFIX}${modulePrefix}${out}`;
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
  const prefix = getQueueTopicPrefix(
    'workflow',
    resolveQueueNamespace(options?.namespace)
  );
  return `${prefix}${SCHEDULE_TOPIC_MARKER}${encodeScheduleTopicSuffix(workflowName)}`;
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
