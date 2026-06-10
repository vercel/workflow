import type { AnyEventRequest } from '@workflow/world';
import { encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { createWorkflowRunEvent } from './events.js';

const ORIGIN = 'https://vercel-workflow.com';

function mockAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

/**
 * Legacy (spec-version-1) runs predate event sourcing: the runtime still
 * posts hook_received (resumeHook) and wait_completed (wakeUpRun) for them
 * with `v1Compat: true`, expecting the legacy `/v1/runs/:id/events`
 * endpoint — NOT the v4 protocol. This locks in the fallback so the v4
 * migration can't silently break webhooks/waits on pre-event-sourcing runs.
 */
describe('createWorkflowRunEvent with v1Compat', () => {
  it.each([
    {
      eventType: 'hook_received' as const,
      data: {
        eventType: 'hook_received',
        correlationId: 'hook_1',
        specVersion: 1,
        eventData: { payload: { hello: 'world' } },
      },
      responseEventData: { payload: { hello: 'world' } },
    },
    {
      eventType: 'wait_completed' as const,
      data: {
        eventType: 'wait_completed',
        correlationId: 'wait_1',
        specVersion: 1,
        eventData: { resumeAt: '2026-06-10T00:00:00.000Z' },
      },
      responseEventData: { resumeAt: '2026-06-10T00:00:00.000Z' },
    },
  ])('posts $eventType to the legacy v1 events endpoint', async ({
    eventType,
    data,
    responseEventData,
  }) => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/runs/wrun_legacy/events', method: 'POST' })
      .reply(
        200,
        {
          eventId: 'evnt_legacy',
          runId: 'wrun_legacy',
          eventType,
          correlationId: data.correlationId,
          createdAt: '2026-06-10T00:00:00.000Z',
          specVersion: 1,
          eventData: responseEventData,
        },
        { headers: { 'content-type': 'application/json' } }
      );

    const result = await createWorkflowRunEvent(
      'wrun_legacy',
      data as AnyEventRequest,
      { v1Compat: true },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.event?.eventId).toBe('evnt_legacy');
    expect(result.event?.eventType).toBe(eventType);
    agent.assertNoPendingInterceptors();
  });

  it('rejects v1Compat without a runId for non-lifecycle events', async () => {
    await expect(
      createWorkflowRunEvent(
        null,
        {
          eventType: 'hook_received',
          correlationId: 'hook_1',
          specVersion: 1,
          eventData: { payload: {} },
        } as AnyEventRequest,
        { v1Compat: true },
        { token: 'test-token' }
      )
    ).rejects.toThrow(/requires a runId/);
  });
});

describe('createWorkflowRunEvent resolveData', () => {
  it("strips payload fields from the returned event when resolveData is 'none'", async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/step_completed',
        method: 'POST',
      })
      .reply(
        200,
        encode({
          event: {
            eventId: 'evnt_1',
            runId: 'wrun_1',
            eventType: 'step_completed',
            correlationId: 'step_1',
            createdAt: '2026-06-10T00:00:00.000Z',
            eventData: {
              result: new TextEncoder().encode('"payload-bytes"'),
              stepName: 'my-step',
            },
          },
        }),
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'step_completed',
        correlationId: 'step_1',
        specVersion: 2,
        eventData: {
          result: new TextEncoder().encode('"payload-bytes"'),
        },
      } as AnyEventRequest,
      { resolveData: 'none' },
      { token: 'test-token', dispatcher: agent }
    );

    // The Storage contract: a caller asking for resolveData 'none' must
    // not get payload bytes back — only entity metadata.
    const eventData = (result.event as { eventData?: Record<string, unknown> })
      ?.eventData;
    expect(eventData?.result).toBeUndefined();
    expect(eventData?.stepName).toBe('my-step');
    agent.assertNoPendingInterceptors();
  });
});
