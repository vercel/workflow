import type { Event } from '@workflow/world';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkflowQueueName, loadWorkflowRunEvents } from './helpers.js';

// Mock the logger to suppress output during tests
vi.mock('../logger.js', () => ({
  runtimeLogger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const eventsListMock = vi.fn();

vi.mock('./get-world-lazy.js', () => ({
  getWorldLazy: vi.fn(async () => ({
    events: {
      list: eventsListMock,
    },
  })),
}));

const makeEvent = (eventId: string): Event =>
  ({
    eventId,
    runId: 'wrun_mockidnumber0001',
    eventType: 'step_created',
    correlationId: 'step_mock',
    createdAt: new Date(),
  }) as unknown as Event;

describe('getWorkflowQueueName', () => {
  it('should return a valid queue name for a simple workflow name', () => {
    expect(getWorkflowQueueName('myWorkflow')).toBe(
      '__wkf_workflow_myWorkflow'
    );
  });

  it('should allow alphanumeric characters', () => {
    expect(getWorkflowQueueName('workflow123')).toBe(
      '__wkf_workflow_workflow123'
    );
  });

  it('should allow underscores and hyphens', () => {
    expect(getWorkflowQueueName('my_workflow-name')).toBe(
      '__wkf_workflow_my_workflow-name'
    );
  });

  it('should allow dots', () => {
    expect(getWorkflowQueueName('my.workflow')).toBe(
      '__wkf_workflow_my.workflow'
    );
  });

  it('should allow forward slashes', () => {
    expect(getWorkflowQueueName('workflow//module//fn')).toBe(
      '__wkf_workflow_workflow//module//fn'
    );
  });

  it('should allow at signs for scoped package names', () => {
    expect(
      getWorkflowQueueName('workflow//@internal/agent@0.0.0//myWorkflow')
    ).toBe('__wkf_workflow_workflow//@internal/agent@0.0.0//myWorkflow');
  });

  it('should allow scoped packages with subpath exports', () => {
    expect(
      getWorkflowQueueName(
        'workflow//@scope/package/subpath@1.2.3//handleRequest'
      )
    ).toBe(
      '__wkf_workflow_workflow//@scope/package/subpath@1.2.3//handleRequest'
    );
  });

  it('should throw for names containing spaces', () => {
    expect(() => getWorkflowQueueName('my workflow')).toThrow(
      'Invalid workflow name'
    );
  });

  it('should throw for names containing special characters', () => {
    expect(() => getWorkflowQueueName('workflow$name')).toThrow(
      'Invalid workflow name'
    );
    expect(() => getWorkflowQueueName('workflow#name')).toThrow(
      'Invalid workflow name'
    );
    expect(() => getWorkflowQueueName('workflow!name')).toThrow(
      'Invalid workflow name'
    );
  });

  it('should throw for empty string', () => {
    expect(() => getWorkflowQueueName('')).toThrow('Invalid workflow name');
  });
});

describe('loadWorkflowRunEvents', () => {
  beforeEach(() => {
    eventsListMock.mockReset();
  });

  it('returns the cursor from the last page when pagination terminates normally', async () => {
    const page1 = [makeEvent('evnt_a'), makeEvent('evnt_b')];
    eventsListMock.mockResolvedValueOnce({
      data: page1,
      cursor: 'eid:evnt_b',
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents('wrun_test');

    expect(result.events).toHaveLength(2);
    expect(result.cursor).toBe('eid:evnt_b');
    expect(eventsListMock).toHaveBeenCalledTimes(1);
  });

  // Regression test for the "Event cursor missing after initial load" warning.
  //
  // A World may legitimately return `{ data: [], cursor: null, hasMore: false }`
  // on a trailing empty page — workflow-server does this whenever the previous
  // page's DynamoDB query hit `Limit` exactly and DynamoDB returned a
  // `LastEvaluatedKey` "just in case." If the pagination loop overwrites the
  // cursor with `null` on that trailing page, the runtime's incremental-load
  // path can't proceed and falls back to a full reload on every replay
  // iteration, logging "Event cursor missing after initial load" each time.
  it('preserves the cursor from the previous page when the final page is empty', async () => {
    const page1 = [makeEvent('evnt_a'), makeEvent('evnt_b')];
    eventsListMock.mockResolvedValueOnce({
      data: page1,
      cursor: 'eid:evnt_b',
      hasMore: true,
    });
    eventsListMock.mockResolvedValueOnce({
      data: [],
      cursor: null,
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents('wrun_test');

    expect(result.events).toHaveLength(2);
    expect(result.cursor).toBe('eid:evnt_b');
    expect(eventsListMock).toHaveBeenCalledTimes(2);
  });

  it('returns null cursor only when no events exist at all', async () => {
    eventsListMock.mockResolvedValueOnce({
      data: [],
      cursor: null,
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents('wrun_test');

    expect(result.events).toHaveLength(0);
    expect(result.cursor).toBeNull();
  });

  it('uses the latest cursor when paginating through multiple non-empty pages', async () => {
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_a')],
      cursor: 'eid:evnt_a',
      hasMore: true,
    });
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_b')],
      cursor: 'eid:evnt_b',
      hasMore: true,
    });
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_c')],
      cursor: 'eid:evnt_c',
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents('wrun_test');

    expect(result.events.map((e) => e.eventId)).toEqual([
      'evnt_a',
      'evnt_b',
      'evnt_c',
    ]);
    expect(result.cursor).toBe('eid:evnt_c');
  });

  it('falls back to the afterCursor when an incremental load returns no events', async () => {
    eventsListMock.mockResolvedValueOnce({
      data: [],
      cursor: null,
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents('wrun_test', 'eid:evnt_z');

    expect(result.events).toHaveLength(0);
    // Preserving the input cursor avoids the runtime treating "no new events
    // since last poll" as "I have no idea where I am in the log."
    expect(result.cursor).toBe('eid:evnt_z');
  });
});
