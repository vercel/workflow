import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SlotConflictError } from '@workflow/errors';
import type { Storage } from '@workflow/world';
import {
  FIRST_SLOT,
  maxSlotOf,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SLOT_IDENTITY,
  slotEventId,
  slotFromId,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from './index.js';

let testDir: string;
let storage: Storage;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slot-identity-'));
  storage = createStorage(testDir);
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

/** Start a run whose events are numbered by slot, and return its id. */
async function newSlotRun(): Promise<string> {
  const result = await storage.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_SLOT_IDENTITY,
    eventData: {
      deploymentId: 'dpl_test',
      workflowName: 'test-workflow',
      input: new Uint8Array(),
    },
  });
  if (!result.run) {
    throw new Error('Expected run to be created');
  }
  return result.run.runId;
}

/**
 * The slots of the run's log, in list order. The page size is explicit: the
 * default would silently truncate a fan-out and make a dense log look sparse.
 */
async function slotsOf(runId: string): Promise<number[]> {
  const { data } = await eventsOf(runId);
  return data.map((event) => slotFromId(event.eventId) ?? -1);
}

function eventsOf(runId: string) {
  return storage.events.list({ runId, pagination: { limit: 500 } });
}

async function createStep(
  runId: string,
  stepId: string,
  eventId?: string
): Promise<string> {
  const result = await storage.events.create(
    runId,
    {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_SLOT_IDENTITY,
      correlationId: stepId,
      eventData: { stepName: 'a-step', input: new Uint8Array() },
    },
    eventId === undefined ? undefined : { eventId }
  );
  if (!result.event) {
    throw new Error('Expected an event');
  }
  return result.event.eventId;
}

describe('numbering', () => {
  it('puts run_created in the first slot', async () => {
    const runId = await newSlotRun();
    await expect(slotsOf(runId)).resolves.toEqual([FIRST_SLOT]);
  });

  it('allocates dense slots for writers that hold no log', async () => {
    // A step completion reporting in, a cancellation from an API call: the
    // caller has no event log, so the world numbers the event for it.
    const runId = await newSlotRun();
    await createStep(runId, 'step_a');
    await createStep(runId, 'step_b');
    await expect(slotsOf(runId)).resolves.toEqual([1, 2, 3]);
  });

  it('honours a slot the caller claims', async () => {
    const runId = await newSlotRun();
    const eventId = await createStep(runId, 'step_a', slotEventId(2));
    expect(eventId).toBe(slotEventId(2));
    await expect(slotsOf(runId)).resolves.toEqual([1, 2]);
  });

  it('keeps a burst of concurrent writers dense', async () => {
    // The suspension flush issues every op at once. Density is what lets a
    // reader prove its log is complete, so a burst must not leave holes.
    const runId = await newSlotRun();
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createStep(runId, `step_${index}`)
      )
    );
    expect(new Set(ids).size).toBe(ids.length);
    const slots = await slotsOf(runId);
    expect([...slots].sort((a, b) => a - b)).toEqual(
      Array.from({ length: ids.length + 1 }, (_, index) => FIRST_SLOT + index)
    );
  });

  it('proves completeness: the highest slot is the event count', async () => {
    const runId = await newSlotRun();
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createStep(runId, `step_${index}`)
      )
    );
    const { data } = await eventsOf(runId);
    expect(maxSlotOf(data)).toBe(data.length);
  });

  it('leaves no hole behind a rejected write', async () => {
    // The rejected op's slot sits below its concurrent sibling's, and a hole
    // below a published event can never be filled.
    const runId = await newSlotRun();
    const [rejected, accepted] = await Promise.allSettled([
      storage.events.create(runId, {
        eventType: 'step_completed',
        specVersion: SPEC_VERSION_SLOT_IDENTITY,
        correlationId: 'step_never_created',
        eventData: { output: new Uint8Array() },
      }),
      createStep(runId, 'step_a'),
    ]);
    expect(rejected.status).toBe('rejected');
    expect(accepted.status).toBe('fulfilled');
    await createStep(runId, 'step_b');
    const slots = await slotsOf(runId);
    expect([...slots].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

/**
 * A lazy step start: a `step_started` carrying the step's creation data, which
 * the world materializes into a step plus the `step_created` event the caller
 * deferred — one request, two events.
 */
async function startStepLazily(
  runId: string,
  stepId: string,
  eventId?: string
): Promise<string> {
  const result = await storage.events.create(
    runId,
    {
      eventType: 'step_started',
      specVersion: SPEC_VERSION_SLOT_IDENTITY,
      correlationId: stepId,
      eventData: { stepName: 'a-step', input: new Uint8Array(), attempt: 0 },
    },
    eventId === undefined ? undefined : { eventId }
  );
  if (!result.event) {
    throw new Error('Expected an event');
  }
  return result.event.eventId;
}

describe('a write that publishes two events', () => {
  it('numbers the deferred step_created below the claim', async () => {
    // The caller reserves both positions and names only the top one, so the
    // pair is fixed before either lands — which is what keeps it off the slot
    // the next write of the same batch is holding.
    const runId = await newSlotRun();
    const startedEventId = await startStepLazily(
      runId,
      'step_a',
      slotEventId(3)
    );
    expect(startedEventId).toBe(slotEventId(3));
    await expect(slotsOf(runId)).resolves.toEqual([1, 2, 3]);
  });

  it('allocates both positions for a start that claims neither', async () => {
    const runId = await newSlotRun();
    await startStepLazily(runId, 'step_a');
    await expect(slotsOf(runId)).resolves.toEqual([1, 2, 3]);
  });

  it('keeps every claim in a burst of lazy starts', async () => {
    // The suspension flush issues its lazy starts at once, each having reserved
    // two positions. A second event numbered off the log as this world sees it
    // would take the slot the next start in the batch claimed, and cost every
    // start after the first its claim — collapsing the fan-out to one step.
    const runId = await newSlotRun();
    const claims = Array.from({ length: 10 }, (_, index) =>
      slotEventId(FIRST_SLOT + 2 * (index + 1))
    );
    const ids = await Promise.all(
      claims.map((eventId, index) =>
        startStepLazily(runId, `step_${index}`, eventId)
      )
    );
    expect(ids).toEqual(claims);
    const slots = await slotsOf(runId);
    expect([...slots].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 2 * claims.length + 1 }, (_, i) => FIRST_SLOT + i)
    );
  });

  it('rejects a claim that leaves no room for the second event', async () => {
    // The run's own run_created holds the first slot, so a claim of the second
    // means the caller reserved one position for a write that publishes two.
    const runId = await newSlotRun();
    await expect(
      startStepLazily(runId, 'step_a', slotEventId(FIRST_SLOT + 1))
    ).rejects.toThrow(/leaves no slot below it/);
  });
});

describe('mode is pinned to the run', () => {
  it('rejects a slot id claimed on a ULID-numbered run', async () => {
    const created = await storage.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      },
    });
    const runId = created.run?.runId as string;
    await expect(createStep(runId, 'step_a', slotEventId(2))).rejects.toThrow(
      /not numbered by slot/
    );
  });

  it('rejects a ULID id claimed on a slot-numbered run', async () => {
    const runId = await newSlotRun();
    await expect(
      createStep(runId, 'step_a', 'evnt_01K5Z0000000000000000000AA')
    ).rejects.toThrow(/not a slot id/);
  });

  it('ignores the spec version of later requests', async () => {
    // A run is in exactly one mode for life; only what was persisted decides.
    const runId = await newSlotRun();
    const result = await storage.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'step_a',
      eventData: { stepName: 'a-step', input: new Uint8Array() },
    });
    expect(slotFromId(result.event?.eventId ?? '')).toBe(2);
  });
});

describe('conflict', () => {
  it('reports the events the loser is missing', async () => {
    const runId = await newSlotRun();
    // Out of band: something else takes the slot this caller was about to
    // claim, so the caller's log is provably missing an event.
    await createStep(runId, 'step_out_of_band');

    const conflict = await storage.events
      .create(
        runId,
        {
          eventType: 'step_created',
          specVersion: SPEC_VERSION_SLOT_IDENTITY,
          correlationId: 'step_a',
          eventData: { stepName: 'a-step', input: new Uint8Array() },
        },
        { eventId: slotEventId(2), maxSlot: 1 }
      )
      .catch((error: unknown) => error);

    expect(SlotConflictError.is(conflict)).toBe(true);
    const slotConflict = conflict as SlotConflictError;
    expect(slotConflict.status).toBe(409);
    expect(slotConflict.eventId).toBe(slotEventId(2));
    expect(slotConflict.events?.map((event) => event.eventId)).toEqual([
      slotEventId(2),
    ]);
  });

  it('lets the loser re-propose at the next free slot', async () => {
    const runId = await newSlotRun();
    await createStep(runId, 'step_out_of_band');
    await expect(createStep(runId, 'step_a', slotEventId(2))).rejects.toThrow(
      SlotConflictError
    );
    // Merging the delta moves the caller's own numbering forward by one.
    const eventId = await createStep(runId, 'step_a', slotEventId(3));
    expect(eventId).toBe(slotEventId(3));
    await expect(slotsOf(runId)).resolves.toEqual([1, 2, 3]);
  });

  it('excludes events the loser already holds from the delta', async () => {
    const runId = await newSlotRun();
    await createStep(runId, 'step_one');
    await createStep(runId, 'step_two');

    const conflict = await storage.events
      .create(
        runId,
        {
          eventType: 'step_created',
          specVersion: SPEC_VERSION_SLOT_IDENTITY,
          correlationId: 'step_a',
          eventData: { stepName: 'a-step', input: new Uint8Array() },
        },
        { eventId: slotEventId(2), maxSlot: 2 }
      )
      .catch((error: unknown) => error);

    // Slots 1 and 2 are at or below what the caller had; only 3 is news.
    expect(
      (conflict as SlotConflictError).events?.map((event) => event.eventId)
    ).toEqual([slotEventId(3)]);
  });

  it('conflicts when another instance takes a claimed slot', async () => {
    // Two instances keep independent books, so the exclusive write — not the
    // book — is what decides who owns a slot. A claim asserts a complete log,
    // so its loser has to reload rather than move over.
    const runId = await newSlotRun();
    const other = createStorage(testDir);
    await other.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_SLOT_IDENTITY,
      correlationId: 'step_b',
      eventData: { stepName: 'b-step', input: new Uint8Array() },
    });
    await expect(createStep(runId, 'step_a', slotEventId(2))).rejects.toThrow(
      SlotConflictError
    );
    await expect(slotsOf(runId)).resolves.toEqual([1, 2]);
  });

  it('reallocates around another instance holding the slot it picked', async () => {
    // Neither writer holds a log, so neither has anything to reconcile: the
    // loser takes the next free position instead of surfacing a conflict its
    // caller could not act on.
    const runId = await newSlotRun();
    const other = createStorage(testDir);
    const outcomes = await Promise.allSettled([
      storage.events.create(runId, {
        eventType: 'step_created',
        specVersion: SPEC_VERSION_SLOT_IDENTITY,
        correlationId: 'step_a',
        eventData: { stepName: 'a-step', input: new Uint8Array() },
      }),
      other.events.create(runId, {
        eventType: 'step_created',
        specVersion: SPEC_VERSION_SLOT_IDENTITY,
        correlationId: 'step_b',
        eventData: { stepName: 'b-step', input: new Uint8Array() },
      }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    await expect(slotsOf(runId)).resolves.toEqual([1, 2, 3]);
  });
});
