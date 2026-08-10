import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { workflowEntrypoint } from '../runtime.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../serialization.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

/**
 * A durable event plus the position the World sorts and paginates it by.
 *
 * Real event ids are ULIDs, so a page is ordered by mint time while a cursor
 * filters by id. The two agree only while events are committed in the order
 * they were minted. `sort` makes that divergence expressible: an event given a
 * position below the current cursor is durable, returned by a full list, and
 * invisible to every incremental read — the shape a `hook_received` takes when
 * its producer minted it before the consumer's last write and committed it
 * after.
 */
type StoredEvent = { event: Event; sort: number };

const RUN_ID = 'wrun_park_recheck_reload';
const HOOK_TOKEN = 'park-recheck-token';

registerStepFunction('parkRecheckStep', async () => 'step-done');

// Creates the hook, runs one step, then parks on the hook. The step is what
// re-arms the pre-park recheck, and the hook is the only wake source left.
const HOOK_AFTER_STEP_WORKFLOW = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const s = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("parkRecheckStep");
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(HOOK_TOKEN)} });
    await s();
    const payload = await hook;
    return payload.message;
  };globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

describe('workflowEntrypoint pre-park log recheck', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('reloads the whole log before a hook-only park, so a hook_received that sorts below the cursor still wakes the run', async () => {
    const workflowRun: WorkflowRun = {
      runId: RUN_ID,
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments([], RUN_ID, undefined, []),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      deploymentId: 'dpl_park_recheck',
      specVersion: SPEC_VERSION_CURRENT,
    };

    const stored: StoredEvent[] = [];
    let nextSort = 1;
    const record = (data: any, sort = nextSort++): Event => {
      const event = {
        eventId: `evnt_${ulid()}`,
        runId: RUN_ID,
        createdAt: new Date(),
        ...data,
      } as Event;
      stored.push({ event, sort });
      return event;
    };

    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType === 'run_started') {
        return { run: workflowRun, events: [] as Event[] };
      }
      if (data.eventType === 'step_started') {
        const lazy = data.eventData as { stepName?: string; input?: unknown };
        if (lazy?.input !== undefined) {
          record({
            eventType: 'step_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: data.correlationId,
            eventData: { stepName: lazy.stepName, input: lazy.input },
          });
        }
        return {
          event: record(data),
          step: {
            runId: RUN_ID,
            stepId: data.correlationId,
            stepName: lazy?.stepName,
            status: 'running' as const,
            attempt: 1,
            input: lazy?.input,
            startedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          ...(lazy?.input !== undefined ? { stepCreated: true } : {}),
        };
      }
      // No inline delta: the loop falls back to `events.list`, which is the
      // read this test is about.
      return { event: record(data) };
    });

    /**
     * Commit the `hook_received` behind the reader's back, at a position below
     * the page just served. Armed for the second delivery only — the delivery
     * that replays a log already holding the open `hook_created`, which is the
     * one that decides to park.
     */
    let injectOnNextFullList = false;
    let injected: Event | undefined;
    const injectHookReceived = async () => {
      const hookCreated = stored.find(
        (s) => s.event.eventType === 'hook_created'
      );
      expect(hookCreated).toBeDefined();
      const maxSort = Math.max(...stored.map((s) => s.sort));
      injected = record(
        {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hookCreated?.event.correlationId,
          eventData: {
            token: HOOK_TOKEN,
            payload: await dehydrateStepReturnValue(
              { message: 'woken' },
              RUN_ID,
              undefined,
              []
            ),
          },
        },
        maxSort - 0.5
      );
    };

    const listPage = (cursor: string | undefined) => {
      const after =
        cursor === undefined ? Number.NEGATIVE_INFINITY : Number(cursor);
      const page = stored
        .filter((s) => s.sort > after)
        .sort((a, b) => a.sort - b.sort);
      return {
        data: page.map((s) => s.event),
        hasMore: false,
        cursor: page.length > 0 ? String(page[page.length - 1]?.sort) : null,
      };
    };

    const eventsList = vi.fn(
      async ({ pagination }: { pagination?: { cursor?: string } }) => {
        const page = listPage(pagination?.cursor);
        if (injectOnNextFullList && pagination?.cursor === undefined) {
          injectOnNextFullList = false;
          await injectHookReceived();
        }
        return page;
      }
    );

    const queueMock = vi.fn(async () => ({ messageId: null }));
    let invokeHandler: (() => Promise<Response>) | undefined;
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      createQueueHandler: vi.fn(
        (
          _prefix: string,
          handler: (message: unknown, metadata: unknown) => Promise<unknown>
        ) => {
          let delivery = 0;
          const invoke = async () => {
            delivery++;
            await handler(
              {
                runId: RUN_ID,
                requestedAt: new Date('2026-01-01T00:00:00.000Z'),
              },
              {
                requestId: `req_park_recheck_${delivery}`,
                attempt: 1,
                queueName: '__wkf_workflow_workflow',
                messageId: `msg_park_recheck_${delivery}`,
              }
            );
            return new Response(null, { status: 204 });
          };
          invokeHandler = invoke;
          return invoke;
        }
      ),
      events: { create: eventsCreate, list: eventsList },
      runs: { get: vi.fn(async () => workflowRun) },
      queue: queueMock,
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    const handler = workflowEntrypoint(HOOK_AFTER_STEP_WORKFLOW);

    // First delivery: creates the hook and runs the step. It ends without the
    // hook payload — nothing has delivered it yet.
    const first = (await handler(
      new Request('https://example.test')
    )) as Response;
    expect(first.status).toBe(204);
    expect(eventsCreate.mock.calls).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'hook_created' }),
      ])
    );
    expect(eventsCreate.mock.calls).not.toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'run_completed' }),
      ])
    );

    // Second delivery replays the full log, finds the step already terminal
    // and parks on the open hook. The payload commits behind its initial read,
    // below the cursor that read returned.
    injectOnNextFullList = true;
    expect(invokeHandler).toBeDefined();
    const second = await invokeHandler?.();
    expect(second?.status).toBe(204);

    // The hole is real: no incremental read from the cursor that delivery held
    // can ever return the payload.
    expect(injected).toBeDefined();
    const cursorAtPark = String(
      Math.max(...stored.filter((s) => s.event !== injected).map((s) => s.sort))
    );
    expect(listPage(cursorAtPark).data).toEqual([]);

    // The park recheck reloads without a cursor, so the run advances rather
    // than wedging in `running` forever.
    expect(eventsList).toHaveBeenCalledWith(
      expect.objectContaining({
        pagination: expect.objectContaining({ cursor: undefined }),
      })
    );
    expect(eventsCreate.mock.calls).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'run_completed' }),
      ])
    );
  });
});
