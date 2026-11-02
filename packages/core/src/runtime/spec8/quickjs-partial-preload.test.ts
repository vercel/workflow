import type { Event, WorkflowRun, World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../../runtime.js';
import { setWorld } from '../world.js';
import { SPEC8_EVENT_SPEC_VERSION } from './constants.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

const runWorkflowWithQuickJS = vi.fn();
vi.mock('./quickjs-entrypoint.js', () => ({ runWorkflowWithQuickJS }));

describe('QuickJS partial run_started preload', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('loads only the suffix before replay', async () => {
    const runId = 'wrun_quickjs_partial_preload';
    const workflowName = 'workflow';
    const startedAt = new Date('2026-05-19T12:00:00.000Z');
    const workflowRun: WorkflowRun = {
      runId,
      workflowName,
      status: 'running',
      input: new Uint8Array(),
      deploymentId: 'dpl_quickjs_partial_preload',
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      executionContext: { workflowVm: 'quickjs' },
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const event = (
      eventId: string,
      data: Omit<Event, 'runId' | 'eventId' | 'createdAt'>
    ): Event => ({
      ...data,
      runId,
      eventId,
      createdAt: startedAt,
    });
    const runCreated = event('evnt_1', {
      eventType: 'run_created',
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      eventData: {
        deploymentId: workflowRun.deploymentId,
        workflowName,
        input: workflowRun.input,
      },
    });
    const runStarted = event('evnt_2', {
      eventType: 'run_started',
      specVersion: SPEC8_EVENT_SPEC_VERSION,
    });
    const hookCreated = event('evnt_3', {
      eventType: 'hook_created',
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      correlationId: 'hook_1',
      eventData: { token: 'token' },
    });
    const preloadCursor = 'cursor-after-run-started';
    const listEvents = vi.fn(async () => ({
      data: [hookCreated],
      cursor: hookCreated.eventId,
      hasMore: false,
    }));
    let dispatch:
      | ((
          message: unknown,
          metadata: { queueName: string; messageId: string; attempt: number }
        ) => Promise<unknown>)
      | undefined;

    setWorld({
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      capabilities: {},
      createQueueHandler: vi.fn((_prefix, handler) => {
        dispatch = handler;
        return vi.fn();
      }),
      events: {
        list: listEvents,
        create: vi.fn(async () => ({
          event: runStarted,
          run: workflowRun,
          events: [runCreated, runStarted],
          cursor: preloadCursor,
          hasMore: true,
        })),
      },
      queue: vi.fn().mockResolvedValue({ messageId: 'msg_queued' }),
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as World);

    await workflowEntrypoint('// QuickJS is mocked')(
      new Request('https://example.test')
    );
    expect(dispatch).toBeDefined();
    await dispatch?.(
      { runId, runSpecVersion: SPEC8_EVENT_SPEC_VERSION },
      {
        queueName: `__wkf_workflow_${workflowName}`,
        messageId: 'msg_workflow',
        attempt: 1,
      }
    );

    expect(listEvents).toHaveBeenCalledWith({
      runId,
      pagination: { sortOrder: 'asc', cursor: preloadCursor },
      resolveData: 'skip-step-inputs',
    });
    expect(runWorkflowWithQuickJS).toHaveBeenCalledWith(
      expect.objectContaining({
        preloadedEvents: [runCreated, runStarted, hookCreated],
        preloadedEventsComplete: true,
      })
    );
  });
});
