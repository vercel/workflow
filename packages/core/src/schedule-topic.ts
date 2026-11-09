import { getQueueTopicPrefix, resolveQueueNamespace } from '@workflow/world';

/**
 * Schedule topics: the Vercel Queues topic a Vercel Schedule publishes to in
 * order to start a workflow. Pure (no runtime imports), so the build can
 * compute the topic of a workflow's `experimental_schedule`.
 */

/** What follows the queue prefix in every schedule topic. */
export const SCHEDULE_TOPIC_MARKER = 'schedule_';

/** Every non-dynamic workflow name starts with it, so the topic leaves it out. */
const WORKFLOW_NAME_PREFIX = 'workflow//';

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
 * The schedule topic of a compiled workflow name: the queue prefix (with the
 * namespace, when there is one), `schedule_`, then the name encoded by
 * {@link encodeScheduleTopicSuffix}.
 */
export function scheduleTopicForWorkflowName(
  workflowName: string,
  namespace?: string
): string {
  const prefix = getQueueTopicPrefix(
    'workflow',
    resolveQueueNamespace(namespace)
  );
  return `${prefix}${SCHEDULE_TOPIC_MARKER}${encodeScheduleTopicSuffix(workflowName)}`;
}
