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
 * Conformance for the in-band writer fence every World implements (see
 * `Storage['events']` and `CreateEventParams.inBand`).
 *
 * What every World must agree on, whatever it stores the count in:
 *
 * - It declares `capabilities.inBandFence`, without which the runtime refuses
 *   it.
 * - `list` returns `snapshot: { seq, seqInBand }`, and a new run holds one
 *   in-band position (`run_created`'s), which `atRunCreation` names.
 * - An in-band write at the current count is accepted and advances it by one.
 * - A stale in-band write is refused with `InBandSupersededError` (412,
 *   `in-band-superseded`) and allocates nothing: the log and the counts are
 *   unchanged, and the next accepted write takes the very next slot.
 * - Out-of-band writes move `seq` and never `seqInBand`.
 * - Of several concurrent in-band writers holding the same count, exactly one
 *   wins.
 * - An in-band write with no expected count is refused with a 400.
 * - The single-orchestrator step bookkeeping (`inline`, `creatorMessageId`,
 *   `stepName`, `attempt`, `startReason`) survives the round trip.
 *
 * Import it from a World's own test file (by relative path, like the other
 * test-support modules) and call it at module level.
 */
export interface InBandFenceConformanceOptions {
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
  /** How many concurrent writers to race. Defaults to 8. */
  concurrentWriters?: number;
}

const SPEC = SPEC_VERSION_SINGLE_ORCHESTRATOR;

/**
 * `@workflow/world` cannot depend on `@workflow/errors`, so errors are
 * recognized the way their own `is()` guards do it: by name.
 */
function errorNamed(value: unknown, name: string): boolean {
  return value instanceof Error && value.name === name;
}

const isSuperseded = (value: unknown) =>
  errorNamed(value, 'InBandSupersededError');

/** `create` without its overloads, so a test can pass any request. */
type CreateAny = (
  runId: string | null,
  data: AnyEventRequest,
  params?: CreateEventParams
) => Promise<EventResult>;

export function inBandFenceConformance(
  options: InBandFenceConformanceOptions
): void {
  const { atRunCreation } = options;

  async function createRun(events: Storage['events']) {
    const result = await (events.create as CreateAny)(
      options.newRunId() ?? '',
      {
        eventType: 'run_created',
        specVersion: SPEC,
        eventData: {
          deploymentId: 'dpl_fence_conformance',
          workflowName: 'fenceConformance',
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

  const waitCreated = (correlationId: string) =>
    ({
      eventType: 'wait_created',
      correlationId,
      specVersion: SPEC,
      eventData: { resumeAt: new Date(Date.now() + 60_000) },
    }) as AnyEventRequest;

  const attrSet = (value: string) =>
    ({
      eventType: 'attr_set',
      specVersion: SPEC,
      eventData: {
        changes: [{ key: 'k', value }],
        writer: { type: 'workflow' },
      },
    }) as AnyEventRequest;

  const runStarted = {
    eventType: 'run_started',
    specVersion: SPEC,
  } as AnyEventRequest;

  const uniqueId = (prefix: string) =>
    `${prefix}_${randomUUID().replaceAll('-', '')}`;

  describe(`in-band fence conformance (${options.name})`, () => {
    test('declares the in-band fence capability', () => {
      expect(options.capabilities()?.inBandFence).toBe(true);
    });

    test('a new run holds run_created as its one in-band position', async () => {
      const events = options.events();
      const runId = await createRun(events);
      expect(await load(events, runId)).toEqual({
        snapshot: { seq: 1, seqInBand: atRunCreation },
        slots: [1],
      });
    });

    test('accepts an in-band write at the current count and advances it by one', async () => {
      const events = options.events();
      const runId = await createRun(events);
      await (events.create as CreateAny)(runId, runStarted, {
        inBand: true,
        expectedSeqInBand: atRunCreation,
      });
      await (events.create as CreateAny)(runId, waitCreated(uniqueId('wait')), {
        inBand: true,
        expectedSeqInBand: atRunCreation + 1,
      });
      expect(await load(events, runId)).toEqual({
        snapshot: { seq: 3, seqInBand: atRunCreation + 2 },
        slots: [1, 2, 3],
      });
    });

    test('refuses a stale in-band write and allocates nothing', async () => {
      const events = options.events();
      const runId = await createRun(events);
      await (events.create as CreateAny)(runId, runStarted, {
        inBand: true,
        expectedSeqInBand: atRunCreation,
      });
      const before = await load(events, runId);
      const waitId = uniqueId('wait');

      const error = await (events.create as CreateAny)(
        runId,
        waitCreated(waitId),
        {
          inBand: true,
          expectedSeqInBand: atRunCreation,
        }
      ).catch((err: unknown) => err);

      expect(isSuperseded(error)).toBe(true);
      expect(error).toMatchObject({ status: 412 });
      expect(await load(events, runId)).toEqual(before);
      // The current writer can still write the same entity, into the very
      // next slot: the refusal left neither a hole nor an entity behind.
      const next = await (events.create as CreateAny)(
        runId,
        waitCreated(waitId),
        {
          inBand: true,
          expectedSeqInBand: before.snapshot?.seqInBand,
        }
      );
      expect(eventIdToSlot(next.event?.eventId ?? '')).toBe(
        (before.snapshot?.seq ?? 0) + 1
      );
    });

    test('out-of-band writes move seq and leave seqInBand alone', async () => {
      const events = options.events();
      const runId = await createRun(events);
      const before = await load(events, runId);
      await (events.create as CreateAny)(runId, attrSet('a'), {
        inBand: false,
      });
      await (events.create as CreateAny)(runId, attrSet('b'));
      const after = await load(events, runId);
      expect(after.snapshot).toEqual({
        seq: (before.snapshot?.seq ?? 0) + 2,
        seqInBand: before.snapshot?.seqInBand,
      });
      await expect(
        (events.create as CreateAny)(runId, runStarted, {
          inBand: true,
          expectedSeqInBand: before.snapshot?.seqInBand,
        })
      ).resolves.toBeDefined();
    });

    test('of concurrent in-band writers holding the same count, exactly one wins', async () => {
      const events = options.events();
      const runId = await createRun(events);
      const { snapshot } = await load(events, runId);
      const writers = options.concurrentWriters ?? 8;
      const outcomes = await Promise.allSettled(
        Array.from({ length: writers }, () =>
          (events.create as CreateAny)(runId, waitCreated(uniqueId('wait')), {
            inBand: true,
            expectedSeqInBand: snapshot?.seqInBand,
          })
        )
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(
        outcomes.filter(
          (o) => o.status === 'rejected' && isSuperseded(o.reason)
        )
      ).toHaveLength(writers - 1);
      expect(await load(events, runId)).toEqual({
        snapshot: { seq: 2, seqInBand: (snapshot?.seqInBand ?? 0) + 1 },
        slots: [1, 2],
      });
    });

    test('refuses an in-band write without an expected count', async () => {
      const events = options.events();
      const runId = await createRun(events);
      const error = await (events.create as CreateAny)(
        runId,
        waitCreated(uniqueId('wait')),
        { inBand: true }
      ).catch((err: unknown) => err);
      expect(errorNamed(error, 'WorkflowWorldError')).toBe(true);
      expect((error as { status?: unknown }).status).toBe(400);
      expect((await load(events, runId)).slots).toEqual([1]);
    });

    test('keeps the step bookkeeping fields on the stored events', async () => {
      const events = options.events();
      const runId = await createRun(events);
      const stepId = uniqueId('step');
      await (events.create as CreateAny)(
        runId,
        {
          eventType: 'step_created',
          correlationId: stepId,
          specVersion: SPEC,
          eventData: {
            stepName: 'add',
            input: new Uint8Array([1]),
            inline: false,
            creatorMessageId: 'msg_creator',
          },
        } as AnyEventRequest,
        { inBand: true, expectedSeqInBand: atRunCreation }
      );
      await (events.create as CreateAny)(
        runId,
        {
          eventType: 'step_started',
          correlationId: stepId,
          specVersion: SPEC,
          eventData: { stepName: 'add', attempt: 1, startReason: 'first' },
        } as AnyEventRequest,
        { inBand: false }
      );
      const page = await events.list({ runId });
      const [created, started] = page.data.slice(1);
      expect(created?.eventData).toMatchObject({
        stepName: 'add',
        inline: false,
        creatorMessageId: 'msg_creator',
      });
      expect(started?.eventData).toMatchObject({
        stepName: 'add',
        attempt: 1,
        startReason: 'first',
      });
    });
  });
}
