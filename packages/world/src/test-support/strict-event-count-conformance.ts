import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type {
  AnyEventRequest,
  CreateEventParams,
  EventResult,
} from '../events.js';
import type { Storage, WorldCapabilities } from '../interfaces.js';
import { eventIdToSlot } from '../slot-identity.js';
import { SPEC_VERSION_SINGLE_ORCHESTRATOR } from '../spec-version.js';

/**
 * Conformance for `strictEventCount` (proof of concept), for a World that
 * declares `capabilities.strictEventCount` (see
 * `CreateEventParams.strictEventCount`):
 *
 * - A strict in-band write commits only at slot `eventCount + 1`.
 * - When that slot is taken, it is refused with `EventSlotTakenError` (412,
 *   `event-slot-taken`) and allocates nothing: the log and the counts are
 *   unchanged, and the next accepted write takes the very next slot.
 * - The in-band fence is checked first: a stale writer gets
 *   `InBandSupersededError`, never `EventSlotTakenError`.
 * - A strict batch commits or is refused as a whole.
 * - An out-of-band write takes a slot a strict write then may not name.
 *
 * Import it from a World's own test file (by relative path, like the other
 * test-support modules) and call it at module level.
 */
export interface StrictEventCountConformanceOptions {
  /** Describe-block name, usually the World's name. */
  name: string;
  /** The events storage under test. Called once per test. */
  events: () => Storage['events'];
  /** The capabilities the World under test declares (`World.capabilities`). */
  capabilities: () => WorldCapabilities | undefined;
  /** A run id for `run_created`, or `null` when the World mints it. */
  newRunId: () => string | null;
  /** In-band positions a new run holds (the World's documented initial count). */
  atRunCreation: number;
  /**
   * Creates a run holding only `run_created` and returns its id, for a World
   * that does not create runs through `events.create`. Defaults to writing
   * `run_created`.
   */
  createRun?: (events: Storage['events']) => Promise<string>;
}

const SPEC = SPEC_VERSION_SINGLE_ORCHESTRATOR;

function errorNamed(value: unknown, name: string): boolean {
  return value instanceof Error && value.name === name;
}

type CreateAny = (
  runId: string | null,
  data: AnyEventRequest,
  params?: CreateEventParams
) => Promise<EventResult>;

export function strictEventCountConformance(
  options: StrictEventCountConformanceOptions
): void {
  const { atRunCreation } = options;

  async function createRun(events: Storage['events']) {
    if (options.createRun) return options.createRun(events);
    const result = await (events.create as CreateAny)(
      options.newRunId() ?? '',
      {
        eventType: 'run_created',
        specVersion: SPEC,
        eventData: {
          deploymentId: 'dpl_strict_conformance',
          workflowName: 'strictConformance',
          input: new Uint8Array([1]),
        },
      } as AnyEventRequest
    );
    const runId = result.event?.runId ?? result.run?.runId;
    expect(typeof runId).toBe('string');
    return runId as string;
  }

  async function load(events: Storage['events'], runId: string) {
    const page = await events.list({ runId });
    return {
      snapshot: page.snapshot,
      slots: page.data.map((event) => eventIdToSlot(event.eventId)),
    };
  }

  const waitCreated = () =>
    ({
      eventType: 'wait_created',
      correlationId: `wait_${randomUUID().replaceAll('-', '')}`,
      specVersion: SPEC,
      eventData: { resumeAt: new Date(Date.now() + 60_000) },
    }) as AnyEventRequest;

  const strict = (eventCount: number, expectedSeqInBand: number) =>
    ({
      inBand: true,
      expectedSeqInBand,
      eventCount,
      strictEventCount: true,
    }) as CreateEventParams;

  describe(`strictEventCount conformance (${options.name})`, () => {
    test('declares the capability', () => {
      expect(options.capabilities()?.strictEventCount).toBe(true);
    });

    test('commits a strict write at the slot after its eventCount', async () => {
      const events = options.events();
      const runId = await createRun(events);
      const result = await (events.create as CreateAny)(
        runId,
        waitCreated(),
        strict(1, atRunCreation)
      );
      expect(eventIdToSlot(result.event!.eventId)).toBe(2);
    });

    test('refuses a taken slot, allocating nothing', async () => {
      const events = options.events();
      const runId = await createRun(events);
      await (events.create as CreateAny)(
        runId,
        waitCreated(),
        strict(1, atRunCreation)
      );
      const before = await load(events, runId);
      const error = await (events.create as CreateAny)(
        runId,
        waitCreated(),
        strict(1, atRunCreation + 1)
      ).catch((err: unknown) => err);
      expect(errorNamed(error, 'EventSlotTakenError')).toBe(true);
      expect(error).toMatchObject({ status: 412 });
      expect(await load(events, runId)).toEqual(before);
      const next = await (events.create as CreateAny)(
        runId,
        waitCreated(),
        strict(2, atRunCreation + 1)
      );
      expect(eventIdToSlot(next.event!.eventId)).toBe(3);
    });

    test('checks the fence before the slot', async () => {
      const events = options.events();
      const runId = await createRun(events);
      await (events.create as CreateAny)(
        runId,
        waitCreated(),
        strict(1, atRunCreation)
      );
      const error = await (events.create as CreateAny)(
        runId,
        waitCreated(),
        strict(1, atRunCreation)
      ).catch((err: unknown) => err);
      expect(errorNamed(error, 'InBandSupersededError')).toBe(true);
    });

    test('commits or refuses a strict batch as a whole', async () => {
      const events = options.events();
      if (!events.createBatch) return;
      const runId = await createRun(events);
      await (events.create as CreateAny)(
        runId,
        waitCreated(),
        strict(1, atRunCreation)
      );
      const before = await load(events, runId);
      const batch = [{ event: waitCreated() }, { event: waitCreated() }];
      const error = await events
        .createBatch(
          runId,
          batch as never,
          strict(1, atRunCreation + 1) as never
        )
        .catch((err: unknown) => err);
      expect(errorNamed(error, 'EventSlotTakenError')).toBe(true);
      expect(await load(events, runId)).toEqual(before);
      await events.createBatch(
        runId,
        batch as never,
        strict(2, atRunCreation + 1) as never
      );
      expect((await load(events, runId)).slots).toEqual([1, 2, 3, 4]);
    });

    test('refuses a strict write naming a slot an out-of-band write took', async () => {
      const events = options.events();
      const runId = await createRun(events);
      await (events.create as CreateAny)(runId, waitCreated());
      const error = await (events.create as CreateAny)(
        runId,
        waitCreated(),
        strict(1, atRunCreation)
      ).catch((err: unknown) => err);
      expect(errorNamed(error, 'EventSlotTakenError')).toBe(true);
    });
  });
}
