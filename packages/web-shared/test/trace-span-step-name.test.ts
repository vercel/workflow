import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { stepToSpan } from '../src/components/workflow-traces/trace-span-construction.js';

const date = (ms: number) => new Date(ms);

function event(overrides: Partial<Event>): Event {
  return {
    runId: 'run_1',
    eventId: `evt_${overrides.eventType ?? 'unknown'}`,
    eventType: 'run_created',
    createdAt: date(1_000),
    specVersion: 2,
    eventData: {
      deploymentId: 'dpl_1',
      workflowName: 'workflow//./workflow//testWorkflow',
      input: null,
    },
    ...overrides,
  } as Event;
}

describe('stepToSpan', () => {
  it('uses the short name for a workflow-prefixed step name', () => {
    const span = stepToSpan(
      [
        event({
          eventType: 'step_created',
          correlationId: 'step_1',
          eventData: {
            stepName: 'workflow//src/billing.ts//fetchInvoices',
            input: null,
          },
        }),
        event({
          eventType: 'step_completed',
          correlationId: 'step_1',
          createdAt: date(2_000),
          eventData: { result: null },
        }),
      ],
      date(2_000)
    );

    expect(span?.name).toBe('fetchInvoices');
  });
});
