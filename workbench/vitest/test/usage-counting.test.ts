import type { Event, RunUsage } from '@workflow/world';
import {
  formatStepCreationNote,
  formatStepEventsBreakdown,
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

describe('run usage from a real run', () => {
  // Runs at whatever spec the World mints: the default, or spec 9 with
  // WORKFLOW_SPEC_VERSION=9, where inline steps write no step_created.
  it('counts and explains the step events the run wrote', async () => {
    const run = await start(usageCountingWorkflow, ['ord_1']);
    await expect(run.returnValue).resolves.toEqual({
      charged: 'charged ord_1',
      sent: 6,
    });

    const world = await getWorld();
    const usage: RunUsage = await world.experimental_usage!.getRun(run.runId);
    const events = await listAllEvents(run.runId);
    const stepLog = events.filter((event) =>
      event.eventType.startsWith('step_')
    );
    const steps = new Set(stepLog.map((event) => event.correlationId)).size;
    const { specVersion } = await world.runs.get(run.runId);
    console.log(
      `spec ${specVersion}: ${events.length} events; ${formatStepEventsBreakdown(usage)}; ${formatStepCreationNote(usage) ?? 'every step has a created event'}`
    );

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
        retrying: countOf(events, 'step_retrying'),
        other: 0,
      },
    });
    expect(steps).toBe(7);

    // The breakdown adds up to the step spans.
    const stepSpans = usage.eventsBySpan.filter((span) => span.kind === 'step');
    expect(stepSpans.reduce((sum, span) => sum + span.events, 0)).toBe(
      usage.stepEvents.events
    );
    expect(
      Object.values(usage.stepEvents.byType).reduce((a, b) => a + b, 0)
    ).toBe(usage.stepEvents.events);

    // And the explanation states the run's own numbers.
    const { byType } = usage.stepEvents;
    expect(formatStepEventsBreakdown(usage)).toBe(
      `7 steps wrote ${stepLog.length} events: ` +
        [
          byType.created > 0 && `${byType.created} created`,
          `${byType.started} started`,
          `${byType.completed} completed`,
          '2 retry markers',
        ]
          .filter(Boolean)
          .join(', ')
    );
    if (specVersion !== undefined && specVersion >= 9) {
      // Inline steps are created by their first step_started.
      expect(byType.created).toBeLessThan(steps);
      expect(formatStepCreationNote(usage)).toMatch(/no created event/);
    } else {
      // Spec 8 writes a step_created for every step, inline ones included.
      expect(byType.created).toBe(steps);
      expect(formatStepCreationNote(usage)).toBeNull();
    }
  }, 60_000);
});
