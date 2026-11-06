/**
 * A spec 8 run's queued step attempts (a retry, the background steps of a
 * fan-out) read their input from the `step_started` response: the spec 8
 * step executor hydrates `step.input` from it. This drives the real spec 8
 * runtime on world-local, with every `step_started` answered through
 * world-vercel's real event client against a backend that resolves a step's
 * input into the response only when the request asks it to, as world-vercel's
 * does. A lazy answer leaves `step.input` undefined, and the attempt fails.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetryableError } from '@workflow/errors';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type EventResult,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type World,
} from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { createStorage } from '@workflow/world-vercel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// world-vercel's own copies, so the mock backend speaks its wire format.
import {
  decode,
  encode,
} from '../../../../world-vercel/node_modules/cbor-x/index.js';
import { MockAgent } from '../../../../world-vercel/node_modules/undici/index.js';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { setWorld } from '../world.js';

const SPEC_8 = SPEC_VERSION_SINGLE_ORCHESTRATOR - 1;
const FAN_OUT = 6;

const calls = { double: 0, flaky: 0 };
registerStepFunction('spec8_contract_double', async (n: number) => {
  calls.double++;
  return n * 2;
});
registerStepFunction('spec8_contract_flaky', async (n: number) => {
  calls.flaky++;
  if (calls.flaky === 1) {
    throw new RetryableError('transient', { retryAfter: 1000 });
  }
  return n + 1;
});

const WORKFLOW_CODE = `
  const double = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("spec8_contract_double");
  const flaky = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("spec8_contract_flaky");
  async function workflow(a) {
    const parts = await Promise.all(
      Array.from({ length: ${FAN_OUT} }, (_, i) => double(i + 1))
    );
    return parts.reduce((x, y) => x + y, 0) + (await flaky(a));
  }
  ;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;

/** The v4 frame's CBOR meta block (a 4-byte length, then the meta). */
function frameMeta(body: unknown): Record<string, unknown> {
  const bytes =
    typeof body === 'string'
      ? new TextEncoder().encode(body)
      : new Uint8Array(body as ArrayBufferLike);
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(0, false);
  return decode(bytes.subarray(4, 4 + length)) as Record<string, unknown>;
}

describe('a spec 8 run on world-vercel', () => {
  let dataDir: string;
  let world: LocalWorld | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wf-spec8-step-input-'));
    calls.double = 0;
    calls.flaky = 0;
    // The event client's socket transport is not what this test is about.
    vi.stubEnv('WORKFLOW_EVENTS_TRANSPORT', 'http');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    setWorld(undefined);
    await world?.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("runs queued step attempts with the input world-vercel's step_started response resolves", async () => {
    world = createWorld({ dataDir });
    const local = world;
    const commit = local.events.create.bind(local.events);

    // Each `step_started` commits on world-local, and its response comes
    // back through world-vercel's client: resolved when the client asks for
    // it, else without the step's input.
    const committed = new Map<string, EventResult<'step_started'>>();
    const remoteRefBehaviors: unknown[] = [];
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(() => true)
      .intercept({
        path: (path: string) => path.endsWith('/events/step_started'),
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          const meta = frameMeta(opts.body);
          remoteRefBehaviors.push(meta.remoteRefBehavior);
          const result = committed.get(meta.correlationId as string)!;
          const step = result.step!;
          return encode({
            event: result.event,
            step:
              meta.remoteRefBehavior === 'resolve'
                ? step
                : { ...step, input: undefined },
          });
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_unused',
            'x-wf-run-id': 'wrun_unused',
            'x-wf-created-at': new Date().toISOString(),
          },
        }
      )
      .persist();
    const vercelEvents = createStorage({
      token: 'test-token',
      dispatcher: agent,
    }).events;
    local.events.create = (async (
      runId: string,
      data: CreateEventRequest,
      params?: CreateEventParams
    ) => {
      if (data.eventType !== 'step_started') {
        return commit(runId as never, data as never, params);
      }
      committed.set(
        data.correlationId as string,
        (await commit(runId, data, params)) as EventResult<'step_started'>
      );
      return vercelEvents.create(runId, data, params);
    }) as typeof local.events.create;

    local.registerHandler('__wkf_workflow_', workflowEntrypoint(WORKFLOW_CODE));
    setWorld(local as unknown as World);
    await local.start();
    const created = await commit(null, {
      eventType: 'run_created',
      specVersion: SPEC_8,
      eventData: {
        deploymentId: 'dpl_spec8_step_input',
        workflowName: 'workflow',
        input: await dehydrateWorkflowArguments([10], 'wrun_', undefined, []),
      },
    });
    const runId = created.run?.runId as string;
    await local.queue('__wkf_workflow_workflow', { runId });

    await vi.waitFor(
      async () => {
        const run = await local.runs.get(runId);
        expect(run.status).not.toBe('running');
        expect(run.status).not.toBe('pending');
      },
      { timeout: 30_000, interval: 100 }
    );
    const run = await local.runs.get(runId);
    expect(run.status).toBe('completed');
    expect(calls).toEqual({ double: FAN_OUT, flaky: 2 });
    expect(remoteRefBehaviors.length).toBeGreaterThan(0);
    expect(new Set(remoteRefBehaviors)).toEqual(new Set(['resolve']));
  }, 60_000);
});
