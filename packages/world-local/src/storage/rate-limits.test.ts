/**
 * `experimental_rateLimit()` on the Local World: a `rate_created` reserves its
 * call's slot in the write's transaction and commits the decision in its
 * place, and a `rate_acquired` is checked against the `rate_created` it names.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EntityConflictError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type AnyEventRequest,
  type Event,
  eventIdToSlot,
  SPEC_VERSION_RATE_LIMITS,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage } from '../storage.js';

let testDir: string;
let storage: ReturnType<typeof createStorage>;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-rate-'));
  storage = createStorage(testDir);
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(testDir, { recursive: true, force: true });
});

const serialized = (value: unknown) =>
  ({ data: JSON.stringify(value), encoding: 'json' }) as never;

async function createRun(specVersion: number = SPEC_VERSION_RATE_LIMITS) {
  const created = await storage.events.create('', {
    eventType: 'run_created',
    specVersion,
    eventData: {
      deploymentId: 'dpl_rate',
      workflowName: 'rateWorkflow',
      input: serialized([]),
    },
  } as AnyEventRequest);
  const runId = created.event?.runId as string;
  await inBand(runId, { eventType: 'run_started', specVersion });
  return runId;
}

/** An in-band write carrying the run's current fence count. */
async function inBand(runId: string, data: Record<string, unknown>) {
  const page = await storage.events.list({ runId });
  return storage.events.create(runId, data as AnyEventRequest, {
    inBand: true,
    expectedSeqInBand: page.snapshot?.seqInBand,
  });
}

let calls = 0;
function rateCreated(
  overrides: Record<string, unknown> = {},
  correlationId = `rate_${String(++calls).padStart(26, '0')}`
) {
  return {
    eventType: 'rate_created',
    specVersion: SPEC_VERSION_RATE_LIMITS,
    correlationId,
    eventData: {
      key: 'openai',
      limit: 1,
      periodMs: 60_000,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      creatorMessageId: 'msg_1',
      ...overrides,
    },
  };
}

function committed(result: { event?: Event }): Event {
  if (!result.event) throw new Error('no event committed');
  return result.event;
}

describe('rate limits on the Local World', () => {
  it('commits rate_acquired in place of a call whose slot is now', async () => {
    const runId = await createRun();
    const event = committed(await inBand(runId, rateCreated()));
    expect(event.eventType).toBe('rate_acquired');
    if (event.eventType !== 'rate_acquired') return;
    expect(event.eventData).toMatchObject({ key: 'openai', limit: 1 });
    expect(event.eventData.acquireAt!.getTime()).toBeLessThanOrEqual(
      event.createdAt.getTime()
    );
  });

  it('commits rate_created with acquireAt for a call that has to wait', async () => {
    const runId = await createRun();
    const first = committed(await inBand(runId, rateCreated()));
    const second = committed(await inBand(runId, rateCreated()));
    expect(second.eventType).toBe('rate_created');
    if (first.eventType !== 'rate_acquired') throw new Error('not granted');
    if (second.eventType !== 'rate_created') return;
    // One per minute: exactly one interval after the first slot.
    expect(
      second.eventData.acquireAt!.getTime() -
        first.eventData.acquireAt!.getTime()
    ).toBeGreaterThanOrEqual(60_000 - 1);
    // Kept, so the creating message arms the wait's timer.
    expect(second.eventData.creatorMessageId).toBe('msg_1');
  });

  it('commits rate_failed past the deadline, and reserves nothing', async () => {
    const runId = await createRun();
    committed(await inBand(runId, rateCreated()));
    const failed = committed(
      await inBand(
        runId,
        rateCreated({ expiresAt: new Date(Date.now() + 30_000) })
      )
    );
    expect(failed.eventType).toBe('rate_failed');
    if (failed.eventType === 'rate_failed') {
      expect(failed.eventData.reason).toBe('timeout');
    }
    // The next call still gets the slot the failed one would have had.
    const next = committed(await inBand(runId, rateCreated()));
    if (next.eventType !== 'rate_created' || failed.eventType !== 'rate_failed')
      throw new Error('unexpected');
    expect(next.eventData.acquireAt).toEqual(failed.eventData.acquireAt);
  });

  it('shares a key across runs', async () => {
    const a = await createRun();
    const b = await createRun();
    expect(committed(await inBand(a, rateCreated())).eventType).toBe(
      'rate_acquired'
    );
    expect(committed(await inBand(b, rateCreated())).eventType).toBe(
      'rate_created'
    );
    // Another key is not affected.
    expect(
      committed(await inBand(b, rateCreated({ key: 'anthropic' }))).eventType
    ).toBe('rate_acquired');
  });

  it('accepts rate_acquired once, after acquireAt, for its own rate_created', async () => {
    // The World's clock, held still between the writes and then moved past
    // the slot, so a slow machine cannot turn the wait into a grant.
    vi.useFakeTimers({ toFake: ['Date'] });
    const runId = await createRun();
    committed(await inBand(runId, rateCreated()));
    const waiting = committed(await inBand(runId, rateCreated()));
    if (waiting.eventType !== 'rate_created') throw new Error('not waiting');
    const createdSlot = eventIdToSlot(waiting.eventId) as number;
    const acquired = {
      eventType: 'rate_acquired',
      specVersion: SPEC_VERSION_RATE_LIMITS,
      correlationId: waiting.correlationId,
      eventData: { createdSlot },
    };

    await expect(inBand(runId, acquired)).rejects.toThrow(TooEarlyError);
    await expect(
      inBand(runId, { ...acquired, correlationId: 'rate_other' })
    ).rejects.toThrow(EntityConflictError);
    await expect(
      inBand(runId, { ...acquired, eventData: { createdSlot: 1 } })
    ).rejects.toThrow(EntityConflictError);

    vi.setSystemTime(waiting.eventData.acquireAt!.getTime());
    const done = committed(await inBand(runId, acquired));
    expect(done.eventType).toBe('rate_acquired');
    if (done.eventType !== 'rate_acquired') return;
    // The recorded acquireAt, never one the request carried.
    expect(done.eventData.acquireAt).toEqual(waiting.eventData.acquireAt);
    expect(done.eventData.createdSlot).toBe(createdSlot);

    await expect(inBand(runId, acquired)).rejects.toThrow(EntityConflictError);
  });

  it('refuses rate events it may not decide', async () => {
    const spec9 = await createRun(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    await expect(inBand(spec9, rateCreated())).rejects.toThrow(/spec version/);

    const runId = await createRun();
    await expect(
      storage.events.create(runId, rateCreated() as AnyEventRequest)
    ).rejects.toThrow(/in-band/);
    await expect(
      inBand(runId, {
        eventType: 'rate_failed',
        specVersion: SPEC_VERSION_RATE_LIMITS,
        correlationId: 'rate_x',
        eventData: {},
      })
    ).rejects.toThrow(WorkflowWorldError);
    await expect(inBand(runId, rateCreated({ key: '' }))).rejects.toThrow(
      /non-empty/
    );
    // None of those reserved anything.
    expect(committed(await inBand(runId, rateCreated())).eventType).toBe(
      'rate_acquired'
    );
  });

  it('reserves nothing for a finished run', async () => {
    const runId = await createRun();
    await inBand(runId, {
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_RATE_LIMITS,
      eventData: { output: serialized(null) },
    });
    await expect(inBand(runId, rateCreated())).rejects.toThrow(
      EntityConflictError
    );
    const other = await createRun();
    expect(committed(await inBand(other, rateCreated())).eventType).toBe(
      'rate_acquired'
    );
  });
});
