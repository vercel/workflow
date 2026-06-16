import type { AnyEventRequest } from '@workflow/world';
import { encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { createWorkflowRunEvent, splitEventDataForV4 } from './events.js';

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

/**
 * The split's meta allowlist IS the eventData wire contract on v4. The
 * type-level `assertEventDataWireContractExhaustive` guard in events.ts
 * fails the build if a schema field is routed to neither the payload body
 * nor the frame meta, so a *missing* field can't silently regress. These
 * runtime tests are the complement: they prove the fields that ARE routed
 * actually reach the frame meta with the right values and renames.
 */
describe('splitEventDataForV4 attribute fields', () => {
  it('carries attr_set changes/writer/allowReservedAttributes in the frame meta', () => {
    const { payload, meta } = splitEventDataForV4({
      eventType: 'attr_set',
      correlationId: 'attr_1',
      specVersion: 4,
      eventData: {
        changes: [
          { key: 'phase', value: 'done' },
          { key: 'stale', value: null },
        ],
        writer: { type: 'step', stepId: 'step_1', attempt: 2 },
        allowReservedAttributes: true,
      },
    } as AnyEventRequest);

    expect(payload).toBeUndefined();
    expect(meta.changes).toEqual([
      { key: 'phase', value: 'done' },
      { key: 'stale', value: null },
    ]);
    expect(meta.writer).toEqual({ type: 'step', stepId: 'step_1', attempt: 2 });
    expect(meta.allowReservedAttributes).toBe(true);
  });

  it('carries initial run attributes on run_created', () => {
    const { payload, meta } = splitEventDataForV4({
      eventType: 'run_created',
      specVersion: 4,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        input: new TextEncoder().encode('[]'),
        attributes: { sourceAtStart: 'api' },
      },
    } as AnyEventRequest);

    expect(payload).toBeInstanceOf(Uint8Array);
    expect(meta.attributes).toEqual({ sourceAtStart: 'api' });
    expect(meta.deploymentId).toBe('dpl_1');
    expect(meta.workflowName).toBe('wf');
  });

  it('carries attributes on resilient-start run_started', () => {
    const { meta } = splitEventDataForV4({
      eventType: 'run_started',
      specVersion: 4,
      eventData: {
        input: new TextEncoder().encode('[]'),
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        attributes: { sourceAtStart: 'api' },
      },
    } as AnyEventRequest);

    expect(meta.attributes).toEqual({ sourceAtStart: 'api' });
  });
});

describe('createWorkflowRunEvent response coercion', () => {
  it('coerces ISO-string dates in the returned event and preloaded events', async () => {
    // Persisted events store nested eventData dates as ISO strings
    // (the backend's entity layer converts Date → toISOString on write with
    // no inverse getter). The run_started TTFB preload reads events back
    // from a query, so the POST response's `event`/`events` need the same
    // EventSchema coercion as the GET/LIST path — the runtime calls
    // .getTime() on wait_created.resumeAt during replay.
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
      })
      .reply(
        200,
        encode({
          run: {
            runId: 'wrun_1',
            status: 'running',
            startedAt: new Date('2026-06-10T00:00:01.000Z'),
          },
          event: {
            eventId: 'evnt_2',
            runId: 'wrun_1',
            eventType: 'run_started',
            createdAt: '2026-06-10T00:00:01.000Z',
            eventData: {},
          },
          events: [
            {
              eventId: 'evnt_3',
              runId: 'wrun_1',
              eventType: 'wait_created',
              correlationId: 'wait_1',
              createdAt: '2026-06-10T00:00:02.000Z',
              specVersion: 2,
              eventData: { resumeAt: '2026-06-10T01:00:00.000Z' },
            },
          ],
          cursor: 'cursor-1',
          hasMore: false,
        }),
        {
          headers: {
            'x-wf-event-id': 'evnt_2',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:01.000Z',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      { eventType: 'run_started', specVersion: 2 } as AnyEventRequest,
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.event?.createdAt).toBeInstanceOf(Date);
    const preloaded = result.events?.[0] as {
      createdAt: Date;
      eventData: { resumeAt: Date };
    };
    expect(preloaded.createdAt).toBeInstanceOf(Date);
    expect(preloaded.eventData.resumeAt).toBeInstanceOf(Date);
    expect(preloaded.eventData.resumeAt.getTime()).toBe(
      new Date('2026-06-10T01:00:00.000Z').getTime()
    );
    agent.assertNoPendingInterceptors();
  });

  it('threads the wait entity through to the EventResult', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/wait_created',
        method: 'POST',
      })
      .reply(
        200,
        encode({
          event: {
            eventId: 'evnt_4',
            runId: 'wrun_1',
            eventType: 'wait_created',
            correlationId: 'wait_1',
            createdAt: '2026-06-10T00:00:00.000Z',
            eventData: { resumeAt: '2026-06-10T01:00:00.000Z' },
          },
          wait: {
            waitId: 'wait_1',
            runId: 'wrun_1',
            status: 'pending',
          },
        }),
        {
          headers: {
            'x-wf-event-id': 'evnt_4',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'wait_created',
        correlationId: 'wait_1',
        specVersion: 2,
        eventData: { resumeAt: new Date('2026-06-10T01:00:00.000Z') },
      } as AnyEventRequest,
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.wait).toMatchObject({ waitId: 'wait_1' });
    expect(
      (result.event as { eventData?: { resumeAt?: unknown } })?.eventData
        ?.resumeAt
    ).toBeInstanceOf(Date);
    agent.assertNoPendingInterceptors();
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
