// The text `workflow inspect run <id> --usage` prints. The web UI's Usage
// tab renders the same explanation from the same `@workflow/world`
// formatters.
import { formatRunUsageText } from '@workflow/cli/dist/lib/inspect/usage.js';
import {
  type Event,
  type RunUsage,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import { usageCountingWorkflow } from '../workflows/usage-counting.js';

/** Every event of the run, read page by page. */
async function listAllEvents(runId: string): Promise<Event[]> {
  const world = await getWorld();
  const all: Event[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.events.list({
      runId,
      pagination: { limit: 100, cursor },
      resolveData: 'none',
    });
    all.push(...page.data);
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor);
  return all;
}

const countOf = (events: Event[], eventType: string) =>
  events.filter((event) => event.eventType === eventType).length;

const toNumber = (text: string) => Number(text.replaceAll(',', ''));

/** The log names behind the labels the explanation uses. */
const LABEL_EVENT_TYPES: Record<string, string> = {
  created: 'step_created',
  started: 'step_started',
  completed: 'step_completed',
  failed: 'step_failed',
  'retry marker': 'step_retrying',
  'retry markers': 'step_retrying',
};

/**
 * What the "How events are counted" text says the run's steps wrote, read
 * the way a user reads it. Either a breakdown of the run's own counts
 * (`7 steps wrote 21 events: 3 created, 9 started, ...`), or a fixed rate
 * (`Each step writes 3 events ...; each retry adds 2`), which the reader
 * multiplies out.
 */
function stepEventsTheTextClaims(
  text: string,
  log: { steps: number; retries: number }
): {
  events: number;
  steps?: number;
  byEventType?: Record<string, number>;
  withoutCreated?: number;
} {
  const breakdown = text.match(
    /([\d,]+) steps? wrote ([\d,]+) events?: ([^\n.]*)/
  );
  if (breakdown) {
    const byEventType: Record<string, number> = {};
    for (const part of breakdown[3].split(', ')) {
      const [, count, label] = part.match(/^([\d,]+) (.+)$/) ?? [];
      const eventType = LABEL_EVENT_TYPES[label];
      if (!eventType) throw new Error(`Unknown label in ${part}`);
      byEventType[eventType] = toNumber(count);
    }
    const note = text.match(/([\d,]+) steps? ha(?:s|ve) no created event/);
    const none = /No step has a created event/.test(text);
    return {
      steps: toNumber(breakdown[1]),
      events: toNumber(breakdown[2]),
      byEventType,
      withoutCreated: note
        ? toNumber(note[1])
        : none
          ? toNumber(breakdown[1])
          : 0,
    };
  }
  const fixed = text.match(
    /Each step writes (\d+) events[^\n]*each retry adds (\d+)/i
  );
  if (fixed) {
    return {
      events: Number(fixed[1]) * log.steps + Number(fixed[2]) * log.retries,
    };
  }
  throw new Error(`No step event count in:\n${text}`);
}

async function runAndCheck(options?: { specVersion: number }) {
  const run = await start(usageCountingWorkflow, ['ord_1'], options);
  await expect(run.returnValue).resolves.toEqual({
    charged: 'charged ord_1',
    sent: 6,
  });

  const world = await getWorld();
  const usage: RunUsage = await world.experimental_usage!.getRun(run.runId);
  const events = await listAllEvents(run.runId);
  const stepLog = events.filter((event) => event.eventType.startsWith('step_'));
  const steps = new Set(stepLog.map((event) => event.correlationId)).size;
  const retries = countOf(events, 'step_retrying');
  const { specVersion } = await world.runs.get(run.runId);
  if (options) expect(specVersion).toBe(options.specVersion);
  expect(steps).toBe(7);
  expect(retries).toBe(2);

  // What the user reads first: the explanation's numbers are the log's.
  const text = formatRunUsageText(usage);
  // The paragraph that explains the count, as printed.
  const explained = text
    .split('\n\n')
    .filter((paragraph) =>
      /How events are counted|Each step writes/.test(paragraph)
    )
    .join('\n');
  console.log(
    `spec ${specVersion}: ${events.length} events, ${stepLog.length} of them step events in the log\n${explained}`
  );
  const claim = stepEventsTheTextClaims(text, { steps, retries });
  expect(
    claim.events,
    'the step events the explanation adds up to are the ones in the log'
  ).toBe(stepLog.length);
  // Whatever else the text states must be the log's too.
  if (claim.steps !== undefined) expect(claim.steps).toBe(steps);
  for (const [eventType, count] of Object.entries(claim.byEventType ?? {})) {
    expect(count, eventType).toBe(countOf(events, eventType));
  }
  if (claim.withoutCreated !== undefined) {
    expect(claim.withoutCreated).toBe(steps - countOf(events, 'step_created'));
  }

  // Usage counts the log it pages through, event for event.
  expect(usage.events).toBe(events.length);
  expect(usage.billableEvents).toBe(events.length);
  expect(usage.retries).toEqual({ count: 2, events: 4 });
  expect(usage.stepEvents).toEqual({
    steps,
    events: stepLog.length,
    byType: {
      created: countOf(events, 'step_created'),
      started: countOf(events, 'step_started'),
      completed: countOf(events, 'step_completed'),
      failed: countOf(events, 'step_failed'),
      retrying: retries,
      other: 0,
    },
  });
  // And the breakdown adds up to the step spans.
  const stepSpans = usage.eventsBySpan.filter((span) => span.kind === 'step');
  expect(stepSpans.reduce((sum, span) => sum + span.events, 0)).toBe(
    usage.stepEvents.events
  );
  return {
    specVersion: specVersion ?? 0,
    created: countOf(events, 'step_created'),
    steps,
  };
}

describe('run usage from a real run', () => {
  // A step retried twice, and a fan-out wider than the inline limit, so
  // some calls run inline and the rest are queued.
  it('explains the step events a run at the default spec wrote', async () => {
    const { specVersion, created, steps } = await runAndCheck();
    if (specVersion < SPEC_VERSION_SINGLE_ORCHESTRATOR) {
      // Spec 8 writes a step_created for every step, inline ones included.
      expect(created).toBe(steps);
    }
  }, 60_000);

  // Forced in-process, so CI covers spec 9 without WORKFLOW_SPEC_VERSION.
  it('explains the step events a spec 9 run wrote', async () => {
    const { created, steps } = await runAndCheck({
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    // An inline step is created by its first step_started.
    expect(created).toBeLessThan(steps);
  }, 60_000);
});
