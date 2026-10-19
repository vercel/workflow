import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type {
  AnyEventRequest,
  CreateEventParams,
  Event,
  EventResult,
} from '../events.js';
import type { Storage, WorldCapabilities } from '../interfaces.js';
import { SPEC_VERSION_CURRENT } from '../spec-version.js';

/**
 * Conformance for native concurrency locks (`WorldCapabilities.locks`, the
 * entity contract in `locks.ts`, and the `lock_*` event semantics).
 *
 * What every lock-capable World must agree on, whatever it stores the
 * semaphore in:
 *
 * - It never admits more than `concurrency` holders, however many grants
 *   race for the last slot.
 * - A re-POST of a scope's `lock_created` appends nothing: it returns the
 *   committed `lock_acquired`, or the committed `lock_created` with a fresh
 *   `retryAt`. Waiting K attempts adds exactly one event to the log.
 * - A release frees exactly one slot, and a duplicate release frees nothing.
 * - A release racing the run's terminal reclaim decrements once.
 * - A run's terminal transition (completed, failed, cancelled) frees its
 *   slots, and a grant to a terminal run is refused.
 * - Fencing tokens strictly increase per key.
 * - First writer wins on `concurrency`.
 *
 * Every key is namespaced with a fresh id per test, so suites sharing one
 * backend (or a CI run sharing one tenant) never contend with each other.
 *
 * Import it from a World's own test file (by relative path, like the other
 * test-support modules) and call it at module level.
 */
export interface LockConformanceOptions {
  /** Describe-block name, usually the World's name. */
  name: string;
  /** The events storage under test. Called once per test. */
  events: () => Storage['events'];
  /** The capabilities the World under test declares (`World.capabilities`). */
  capabilities: () => WorldCapabilities | undefined;
  /**
   * The World's optional `locks` admin namespace over the same backing data
   * as `events` (the instance a test got from `events()`), when it has one.
   */
  locks?: (events: Storage['events']) => Storage['locks'];
  /** A run id for `run_created`, or `null` when the World mints it. */
  newRunId: () => string | null;
  /**
   * A second events storage over the same backing data (a second instance on
   * the same data directory or database), so concurrent grants also race
   * across instances. Omit when the World cannot have two instances.
   */
  secondEvents?: (first: Storage['events']) => Storage['events'];
  /** How many concurrent acquirers to race. Defaults to 12. */
  concurrentAcquirers?: number;
  /** Rounds of the release-vs-reclaim race. Defaults to 6. */
  reclaimRaceRounds?: number;
}

const SPEC = SPEC_VERSION_CURRENT;

/** `create` without its overloads, so a test can pass any request. */
type CreateAny = (
  runId: string | null,
  data: AnyEventRequest,
  params?: CreateEventParams
) => Promise<EventResult>;

function errorNamed(value: unknown, name: string): boolean {
  return value instanceof Error && value.name === name;
}

const uniqueId = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll('-', '')}`;

export function lockConformance(options: LockConformanceOptions): void {
  const acquirers = options.concurrentAcquirers ?? 12;
  const reclaimRounds = options.reclaimRaceRounds ?? 6;

  const create = (events: Storage['events']) => events.create as CreateAny;

  async function createRun(events: Storage['events']): Promise<string> {
    const result = await create(events)(options.newRunId() ?? '', {
      eventType: 'run_created',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_lock_conformance',
        workflowName: 'lockConformance',
        input: new Uint8Array([1]),
      },
    } as AnyEventRequest);
    const runId = result.event?.runId ?? result.run?.runId;
    expect(typeof runId).toBe('string');
    await create(events)(
      runId as string,
      {
        eventType: 'run_started',
        specVersion: SPEC,
      } as AnyEventRequest
    );
    return runId as string;
  }

  const lockCreated = (
    correlationId: string,
    key: string,
    concurrency: number,
    extra: { leaseTtlMs?: number } = {}
  ) =>
    ({
      eventType: 'lock_created',
      correlationId,
      specVersion: SPEC,
      eventData: { key, concurrency, ...extra },
    }) as AnyEventRequest;

  const lockReleased = (correlationId: string, key: string) =>
    ({
      eventType: 'lock_released',
      correlationId,
      specVersion: SPEC,
      eventData: { key },
    }) as AnyEventRequest;

  async function acquire(
    events: Storage['events'],
    runId: string,
    key: string,
    concurrency: number,
    correlationId = uniqueId('lock'),
    extra: { leaseTtlMs?: number } = {}
  ) {
    const result = await create(events)(
      runId,
      lockCreated(correlationId, key, concurrency, extra)
    );
    return { correlationId, result, event: result.event as Event };
  }

  async function logOf(events: Storage['events'], runId: string) {
    const page = await events.list({ runId, pagination: { limit: 1000 } });
    return page.data;
  }

  const lockEventsOf = (log: Event[], correlationId: string) =>
    log.filter((event) => event.correlationId === correlationId);

  async function terminate(
    events: Storage['events'],
    runId: string,
    how: 'completed' | 'failed' | 'cancelled'
  ) {
    const request =
      how === 'completed'
        ? {
            eventType: 'run_completed',
            specVersion: SPEC,
            eventData: { output: new Uint8Array([1]) },
          }
        : how === 'failed'
          ? {
              eventType: 'run_failed',
              specVersion: SPEC,
              eventData: { error: new Uint8Array([1]) },
            }
          : { eventType: 'run_cancelled', specVersion: SPEC };
    await create(events)(runId, request as AnyEventRequest);
  }

  /** How many fresh scopes on fresh runs fit under `key` right now. */
  async function freeSlots(
    events: Storage['events'],
    key: string,
    concurrency: number
  ): Promise<number> {
    let granted = 0;
    for (let i = 0; i < concurrency + 1; i++) {
      const runId = await createRun(events);
      const { event } = await acquire(events, runId, key, concurrency);
      if (event.eventType !== 'lock_acquired') break;
      granted++;
    }
    return granted;
  }

  describe(`lock conformance (${options.name})`, () => {
    test('declares the locks capability', () => {
      expect(options.capabilities()?.locks?.concurrency).toBe(true);
    });

    test('grants an uncontended slot with lock_acquired in place of lock_created', async () => {
      const events = options.events();
      const runId = await createRun(events);
      const key = uniqueId('key');
      const { correlationId, result, event } = await acquire(
        events,
        runId,
        key,
        2
      );

      expect(event.eventType).toBe('lock_acquired');
      expect(event.correlationId).toBe(correlationId);
      expect(event).toMatchObject({
        eventData: {
          key,
          concurrency: 2,
          effectiveConcurrency: 2,
          fencingToken: 1,
        },
      });
      expect(result.lock).toMatchObject({
        key,
        status: 'held',
        fencingToken: 1,
      });
      // The log holds only the grant: no lock_created for a scope that never
      // waited.
      expect(
        lockEventsOf(await logOf(events, runId), correlationId).map(
          (e) => e.eventType
        )
      ).toEqual(['lock_acquired']);
    });

    test('never over-admits under concurrent acquires', async () => {
      const first = options.events();
      const second = options.secondEvents?.(first) ?? first;
      const key = uniqueId('key');
      const concurrency = 3;
      const runs = await Promise.all(
        Array.from({ length: acquirers }, () => createRun(first))
      );
      const results = await Promise.all(
        runs.map((runId, i) =>
          acquire(i % 2 === 0 ? first : second, runId, key, concurrency)
        )
      );
      const granted = results.filter(
        (r) => r.event.eventType === 'lock_acquired'
      );
      const pending = results.filter(
        (r) => r.event.eventType === 'lock_created'
      );
      expect(granted).toHaveLength(concurrency);
      expect(pending).toHaveLength(acquirers - concurrency);
      for (const r of pending) {
        expect(r.result.lock?.status).toBe('pending');
        expect(r.result.lock?.retryAt?.getTime()).toBeGreaterThan(
          Date.now() - 1_000
        );
      }
      // Fencing tokens are distinct.
      const tokens = granted.map(
        (r) =>
          (r.event as { eventData: { fencingToken: number } }).eventData
            .fencingToken
      );
      expect(new Set(tokens).size).toBe(concurrency);

      const lock = await options.locks?.(first)?.get(key);
      if (lock) {
        expect(lock.count).toBe(concurrency);
        expect(lock.grantSeq).toBe(concurrency);
      }
      // Retrying every pending scope still admits nobody.
      const retried = await Promise.all(
        pending.map((r, i) =>
          acquire(
            i % 2 === 0 ? first : second,
            r.event.runId,
            key,
            concurrency,
            r.correlationId
          )
        )
      );
      expect(
        retried.filter((r) => r.event.eventType === 'lock_acquired')
      ).toHaveLength(0);
    });

    test('a re-POST of a granted scope returns its lock_acquired and appends nothing', async () => {
      const events = options.events();
      const runId = await createRun(events);
      const key = uniqueId('key');
      const granted = await acquire(events, runId, key, 1);
      const before = await logOf(events, runId);

      const again = await acquire(events, runId, key, 1, granted.correlationId);
      expect(again.event.eventType).toBe('lock_acquired');
      expect(again.event.eventId).toBe(granted.event.eventId);
      expect(await logOf(events, runId)).toHaveLength(before.length);
      const lock = await options.locks?.(events)?.get(key);
      if (lock) expect(lock.count).toBe(1);
    });

    test('waiting adds no events: K re-POSTs of a pending scope append nothing', async () => {
      const events = options.events();
      const key = uniqueId('key');
      const holderRun = await createRun(events);
      await acquire(events, holderRun, key, 1);
      const waiterRun = await createRun(events);
      const first = await acquire(events, waiterRun, key, 1);
      expect(first.event.eventType).toBe('lock_created');
      const before = await logOf(events, waiterRun);

      const retries = 5;
      for (let i = 0; i < retries; i++) {
        const retry = await acquire(
          events,
          waiterRun,
          key,
          1,
          first.correlationId
        );
        expect(retry.event.eventType).toBe('lock_created');
        expect(retry.event.eventId).toBe(first.event.eventId);
        expect(retry.result.lock?.status).toBe('pending');
        expect(retry.result.lock?.retryAt).toBeInstanceOf(Date);
      }
      const after = await logOf(events, waiterRun);
      expect(after.length - before.length).toBe(0);
      expect(lockEventsOf(after, first.correlationId)).toHaveLength(1);
    });

    test('concurrent duplicate deliveries of one scope commit one event', async () => {
      const first = options.events();
      const second = options.secondEvents?.(first) ?? first;
      const key = uniqueId('key');
      const holderRun = await createRun(first);
      await acquire(first, holderRun, key, 1);

      const waiterRun = await createRun(first);
      const correlationId = uniqueId('lock');
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          acquire(i % 2 ? first : second, waiterRun, key, 1, correlationId)
        )
      );
      expect(new Set(results.map((r) => r.event.eventId)).size).toBe(1);
      expect(
        lockEventsOf(await logOf(first, waiterRun), correlationId)
      ).toHaveLength(1);

      // And for a free key: one grant, one slot.
      const freeKey = uniqueId('key');
      const grantRun = await createRun(first);
      const grantId = uniqueId('lock');
      const grants = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          acquire(i % 2 ? first : second, grantRun, freeKey, 2, grantId)
        )
      );
      expect(new Set(grants.map((r) => r.event.eventId)).size).toBe(1);
      expect(grants[0].event.eventType).toBe('lock_acquired');
      expect(await freeSlots(first, freeKey, 2)).toBe(1);
    });

    test('a release frees exactly one slot, and a duplicate release frees nothing', async () => {
      const events = options.events();
      const key = uniqueId('key');
      const concurrency = 2;
      const holders: { runId: string; correlationId: string }[] = [];
      for (let i = 0; i < concurrency; i++) {
        const runId = await createRun(events);
        const { correlationId, event } = await acquire(
          events,
          runId,
          key,
          concurrency
        );
        expect(event.eventType).toBe('lock_acquired');
        holders.push({ runId, correlationId });
      }
      const waiters = await Promise.all(
        [0, 1, 2].map(async () => {
          const runId = await createRun(events);
          const w = await acquire(events, runId, key, concurrency);
          expect(w.event.eventType).toBe('lock_created');
          return { runId, correlationId: w.correlationId };
        })
      );

      const released = await create(events)(
        holders[0].runId,
        lockReleased(holders[0].correlationId, key)
      );
      expect(released.event?.eventType).toBe('lock_released');

      const duplicate = await create(events)(
        holders[0].runId,
        lockReleased(holders[0].correlationId, key)
      ).catch((err: unknown) => err);
      expect(errorNamed(duplicate, 'EntityConflictError')).toBe(true);

      const retried = await Promise.all(
        waiters.map((w) =>
          acquire(events, w.runId, key, concurrency, w.correlationId)
        )
      );
      expect(
        retried.filter((r) => r.event.eventType === 'lock_acquired')
      ).toHaveLength(1);

      // A scope that released does not get its slot back on a re-POST.
      const reposted = await acquire(
        events,
        holders[0].runId,
        key,
        concurrency,
        holders[0].correlationId
      );
      expect(reposted.event.eventType).toBe('lock_acquired');
      expect(reposted.result.lock?.status).toBe('released');
      const lock = await options.locks?.(events)?.get(key);
      if (lock) expect(lock.count).toBe(concurrency);
    });

    test('a release racing the terminal reclaim never double-decrements', async () => {
      const first = options.events();
      const second = options.secondEvents?.(first) ?? first;
      for (let round = 0; round < reclaimRounds; round++) {
        const key = uniqueId('key');
        const concurrency = 2;
        // One bystander holds a slot the whole time, so a double decrement
        // shows up as a third admission.
        const bystander = await createRun(first);
        await acquire(first, bystander, key, concurrency);
        const runId = await createRun(first);
        const { correlationId, event } = await acquire(
          first,
          runId,
          key,
          concurrency
        );
        expect(event.eventType).toBe('lock_acquired');

        const how = (['completed', 'failed', 'cancelled'] as const)[round % 3];
        await Promise.allSettled([
          create(round % 2 ? first : second)(
            runId,
            lockReleased(correlationId, key)
          ),
          terminate(round % 2 ? second : first, runId, how),
        ]);

        const lock = await options.locks?.(first)?.get(key);
        if (lock) expect(lock.count).toBe(1);
        expect(await freeSlots(first, key, concurrency)).toBe(1);
      }
    });

    for (const how of ['completed', 'failed', 'cancelled'] as const) {
      test(`reclaims a ${how} run's slots and refuses it new grants`, async () => {
        const events = options.events();
        const key = uniqueId('key');
        const runId = await createRun(events);
        // Two scopes on the same key from one run.
        await acquire(events, runId, key, 2);
        await acquire(events, runId, key, 2);
        expect(await freeSlots(events, key, 2)).toBe(0);

        await terminate(events, runId, how);
        const holders = await options.locks?.(events)?.listHolders({ runId });
        if (holders) expect(holders).toEqual([]);

        const refused = await acquire(events, runId, key, 2).catch(
          (err: unknown) => err
        );
        expect(errorNamed(refused, 'EntityConflictError')).toBe(true);
        expect(await freeSlots(events, key, 2)).toBe(2);
      });
    }

    test('fencing tokens strictly increase per key', async () => {
      const events = options.events();
      const key = uniqueId('key');
      const tokens: number[] = [];
      for (let i = 0; i < 5; i++) {
        const runId = await createRun(events);
        const { correlationId, event } = await acquire(events, runId, key, 1);
        expect(event.eventType).toBe('lock_acquired');
        tokens.push(
          (event as { eventData: { fencingToken: number } }).eventData
            .fencingToken
        );
        if (i % 2 === 0) {
          await create(events)(runId, lockReleased(correlationId, key));
        } else {
          await terminate(events, runId, 'completed');
        }
      }
      for (let i = 1; i < tokens.length; i++) {
        expect(tokens[i]).toBeGreaterThan(tokens[i - 1]);
      }
      // Tokens are per key: a different key starts over.
      const other = await acquire(
        events,
        await createRun(events),
        uniqueId('key'),
        1
      );
      expect(other.event).toMatchObject({ eventData: { fencingToken: 1 } });
    });

    test('first writer wins on concurrency', async () => {
      const events = options.events();
      const key = uniqueId('key');
      const firstRun = await createRun(events);
      await acquire(events, firstRun, key, 1);
      const secondRun = await createRun(events);
      const second = await acquire(events, secondRun, key, 5);
      expect(second.event.eventType).toBe('lock_created');
      expect(second.result.lock?.concurrency).toBe(1);

      const roomy = uniqueId('key');
      const a = await acquire(events, await createRun(events), roomy, 3);
      const b = await acquire(events, await createRun(events), roomy, 1);
      expect(a.event.eventType).toBe('lock_acquired');
      expect(b.event).toMatchObject({
        eventType: 'lock_acquired',
        eventData: { concurrency: 1, effectiveConcurrency: 3 },
      });
    });

    test('an opt-in lease can expire, and the fencing token tells the holders apart', async () => {
      const events = options.events();
      const key = uniqueId('key');
      const leased = await acquire(
        events,
        await createRun(events),
        key,
        1,
        uniqueId('lock'),
        { leaseTtlMs: 50 }
      );
      expect(leased.event).toMatchObject({
        eventType: 'lock_acquired',
        eventData: { leaseTtlMs: 50 },
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const next = await acquire(events, await createRun(events), key, 1);
      expect(next.event.eventType).toBe('lock_acquired');
      const token = (e: Event) =>
        (e as { eventData: { fencingToken: number } }).eventData.fencingToken;
      expect(token(next.event)).toBeGreaterThan(token(leased.event));
      const lock = await options.locks?.(events)?.get(key);
      if (lock) expect(lock.count).toBe(1);

      // The expired holder's own release is a no-op that frees nothing.
      await create(events)(
        leased.event.runId,
        lockReleased(leased.correlationId, key)
      );
      expect(await freeSlots(events, key, 1)).toBe(0);
    });

    test('rejects lock_waiter_queued until the World implements the waitlist', async () => {
      const events = options.events();
      const runId = await createRun(events);
      const error = await create(events)(runId, {
        eventType: 'lock_waiter_queued',
        correlationId: uniqueId('lock'),
        specVersion: SPEC,
        eventData: {
          key: uniqueId('key'),
          runId,
          correlationId: uniqueId('lock'),
        },
      } as AnyEventRequest).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
    });

    if (options.locks) {
      test('force-releasing a holder frees its slot exactly once', async () => {
        const events = options.events();
        const admin = options.locks?.(events);
        if (!admin?.releaseHolder) return;
        const key = uniqueId('key');
        const runId = await createRun(events);
        const { correlationId } = await acquire(events, runId, key, 1);
        expect(await admin.listHolders({ key })).toHaveLength(1);
        expect(await admin.releaseHolder({ runId, correlationId })).toEqual({
          released: true,
        });
        expect(await admin.releaseHolder({ runId, correlationId })).toEqual({
          released: false,
        });
        // The holder's later release records the event and frees nothing.
        await create(events)(runId, lockReleased(correlationId, key));
        expect(await freeSlots(events, key, 1)).toBe(1);
      });
    }
  });
}
