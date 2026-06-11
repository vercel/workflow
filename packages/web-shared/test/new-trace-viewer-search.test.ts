import { describe, expect, it } from 'vitest';
import {
  parseSpanSearchQuery,
  searchSpans,
} from '../src/components/new-trace-viewer/search.js';
import type { Span } from '../src/components/trace-viewer/types.js';

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    name: 'Send Email',
    kind: 1,
    resource: 'step',
    library: {
      name: 'workflow-development-kit',
    },
    spanId: 'step_send_email',
    status: {
      code: 0,
    },
    traceFlags: 1,
    attributes: {
      resource: 'step',
      data: {
        stepId: 'step_send_email',
        runId: 'run_123',
        stepName: 'workflow/sendEmail',
        status: 'completed',
        attempt: 2,
      },
    },
    links: [],
    events: [],
    startTime: [0, 0],
    endTime: [1, 0],
    duration: [1, 0],
    ...overrides,
  };
}

describe('new trace viewer search', () => {
  it('parses free text separately from key:value filters', () => {
    expect(
      parseSpanSearchQuery('email resource:step status:completed')
    ).toEqual({
      text: 'email',
      attributes: [
        { key: 'resource', value: 'step' },
        { key: 'status', value: 'completed' },
      ],
    });
  });

  it('matches span names, resources, and span ids', () => {
    const spans = [
      makeSpan(),
      makeSpan({
        name: 'Wait for Approval',
        resource: 'hook',
        spanId: 'hook_approval',
        attributes: { resource: 'hook', data: { status: 'pending' } },
      }),
    ];

    expect(searchSpans(spans, 'send').matchingSpans).toEqual([spans[0]]);
    expect(searchSpans(spans, 'hook').matchingSpans).toEqual([spans[1]]);
    expect(searchSpans(spans, 'approval').matchingSpans).toEqual([spans[1]]);
  });

  it('matches direct and nested attribute filters', () => {
    const spans = [
      makeSpan(),
      makeSpan({
        name: 'Charge Card',
        spanId: 'step_charge',
        attributes: {
          resource: 'step',
          data: {
            stepId: 'step_charge',
            status: 'failed',
            attempt: 3,
          },
        },
      }),
    ];

    expect(
      searchSpans(spans, 'resource:step status:failed').matchingSpans
    ).toEqual([spans[1]]);
    expect(searchSpans(spans, 'data.attempt:2').matchingSpans).toEqual([
      spans[0],
    ]);
  });

  it('requires both text and attribute filters to match', () => {
    const spans = [makeSpan()];

    expect(searchSpans(spans, 'email status:completed').matchingSpans).toEqual(
      spans
    );
    expect(searchSpans(spans, 'email status:failed').matchingSpans).toEqual([]);
  });
});
