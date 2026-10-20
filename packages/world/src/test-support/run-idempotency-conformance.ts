import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type {
  AnyEventRequest,
  CreateEventParams,
  EventResult,
} from '../events.js';
import {
  IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
  IDEMPOTENCY_KEY_TTL_MIN_MS,
  type IdempotencyKeyReusePolicy,
} from '../idempotency.js';
import type { Storage, WorldCapabilities } from '../interfaces.js';
import { SPEC_VERSION_CURRENT } from '../spec-version.js';

/**
 * Conformance for run idempotency keys (see
 * `WorldCapabilities.runIdempotencyKeys` for the contract this checks).
 *
 * What every World that declares the capability must agree on, whatever it
 * stores claims in:
 *
 * - It declares `capabilities.runIdempotencyKeys`.
 * - A keyed `run_created` creates the run and claims the key in one write,
 *   and the key is echoed on the created run and on `runs.get`.
 * - A re-post of the same run id answers `EntityConflictError`, never
 *   `WorkflowRunAlreadyStartedError`.
 * - A different run id is refused while the holder is `pending` or
 *   `running`, whatever the policy, with `WorkflowRunAlreadyStartedError`
 *   (409, `idempotency-key-conflict`) naming the holder and its status, and
 *   nothing is written for the refused run.
 * - A closed holder inside its window is handled by the reuse policy matrix;
 *   a takeover moves the key to the new run.
 * - Of concurrent claimers (fresh key, or a takeover), exactly one wins and
 *   every loser is refused naming the winner.
 * - The window is the holder's own TTL, measured from when it closed; past
 *   it, any policy creates.
 * - A claim whose holder no longer exists is free (when the World can
 *   delete a run).
 * - Keys are scoped by `workflowName`.
 *
 * Import it from a World's own test file (by relative path, like the other
 * test-support modules) and call it at module level:
 *
 * ```ts
 * import { runIdempotencyConformance } from '../../world/src/test-support/run-idempotency-conformance.js';
 *
 * runIdempotencyConformance({
 *   name: 'world-local',
 *   events: () => storage.events,
 *   runs: () => storage.runs,
 *   capabilities: () => world.capabilities,
 *   newRunId: () => `wrun_${ulid()}`,
 * });
 * ```
 */
export interface RunIdempotencyConformanceOptions {
  /** Describe-block name, usually the World's name. */
  name: string;
  /** The events storage under test. Called once per test. */
  events: () => Storage['events'];
  /** The runs storage over the same data as `events`. Called once per test. */
  runs: () => Storage['runs'];
  /** The capabilities the World under test declares (`World.capabilities`). */
  capabilities: () => WorldCapabilities | undefined;
  /**
   * A fresh client-generated run id for `run_created`, in whatever shape the
   * World accepts (keyed starts always send one).
   */
  newRunId: () => string;
  /**
   * Remove a run's record (and whatever else the World removes with it) so
   * the "holder no longer exists" row of the decision table can be checked.
   * Omit when the World cannot delete a run; that test is then skipped.
   */
  deleteRun?: (runId: string) => Promise<void>;
  /**
   * Move the World's clock forward by `ms` for the window-expiry test, for a
   * World that reads an injectable clock. Omitted: the test waits in real
   * time, with the shortest TTL the contract allows (1 s).
   */
  advanceClock?: (ms: number) => void | Promise<void>;
  /** How many concurrent claimers to race. Defaults to 8. */
  concurrentClaimers?: number;
  /** Per-test timeout in milliseconds. Defaults to 30 s. */
  timeoutMs?: number;
}

const SPEC = SPEC_VERSION_CURRENT;

/**
 * `@workflow/world` cannot depend on `@workflow/errors`, so errors are
 * recognized the way their own `is()` guards do it: by name.
 */
function errorNamed(value: unknown, name: string): boolean {
  return value instanceof Error && value.name === name;
}

const isAlreadyStarted = (value: unknown) =>
  errorNamed(value, 'WorkflowRunAlreadyStartedError');
const isEntityConflict = (value: unknown) =>
  errorNamed(value, 'EntityConflictError');

/** `create` without its overloads, so a test can pass any request. */
type CreateAny = (
  runId: string | null,
  data: AnyEventRequest,
  params?: CreateEventParams
) => Promise<EventResult>;

type ClosedStatus = 'completed' | 'failed' | 'cancelled';

/**
 * The reuse-policy half of the decision table for a closed holder inside its
 * window: `true` when the new start takes the key over.
 */
const TAKEOVER_MATRIX: Record<
  IdempotencyKeyReusePolicy,
  Record<ClosedStatus, boolean>
> = {
  ALLOW_DUPLICATE: { completed: true, failed: true, cancelled: true },
  ALLOW_DUPLICATE_FAILED_ONLY: {
    completed: false,
    failed: true,
    cancelled: true,
  },
  REJECT_DUPLICATE: { completed: false, failed: false, cancelled: false },
};

const POLICIES = Object.keys(TAKEOVER_MATRIX) as IdempotencyKeyReusePolicy[];
const CLOSED_STATUSES: ClosedStatus[] = ['completed', 'failed', 'cancelled'];

export function runIdempotencyConformance(
  options: RunIdempotencyConformanceOptions
): void {
  const timeout = options.timeoutMs ?? 30_000;
  const workflowName = `workflow//./idempotency-conformance//${options.name.replace(/[^\w.-]/g, '_')}`;

  const uniqueKey = (prefix = 'key') =>
    `${prefix}-${randomUUID().replaceAll('-', '')}`;

  interface Claim {
    key: string;
    ttlMs?: number;
    policy?: IdempotencyKeyReusePolicy;
    workflowName?: string;
    runId?: string;
  }

  /** Post a keyed `run_created`, the way `start()` does. */
  async function claim(events: Storage['events'], claimOptions: Claim) {
    const runId = claimOptions.runId ?? options.newRunId();
    const result = await (events.create as CreateAny)(runId, {
      eventType: 'run_created',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_idempotency_conformance',
        workflowName: claimOptions.workflowName ?? workflowName,
        input: new Uint8Array([1]),
        idempotencyKey: claimOptions.key,
        idempotencyKeyTtlMs:
          claimOptions.ttlMs ?? IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
        idempotencyKeyReusePolicy: claimOptions.policy ?? 'REJECT_DUPLICATE',
      },
    } as AnyEventRequest);
    return { runId, result };
  }

  /** `claim`, but settle to the refusal instead of throwing. */
  async function claimSettled(events: Storage['events'], claimOptions: Claim) {
    const runId = claimOptions.runId ?? options.newRunId();
    try {
      const { result } = await claim(events, { ...claimOptions, runId });
      return { runId, result, error: undefined };
    } catch (error: unknown) {
      return { runId, result: undefined, error };
    }
  }

  async function start(events: Storage['events'], runId: string) {
    await (events.create as CreateAny)(runId, {
      eventType: 'run_started',
      specVersion: SPEC,
    } as AnyEventRequest);
  }

  async function close(
    events: Storage['events'],
    runId: string,
    status: ClosedStatus
  ) {
    await start(events, runId);
    const create = events.create as CreateAny;
    if (status === 'completed') {
      await create(runId, {
        eventType: 'run_completed',
        specVersion: SPEC,
        eventData: { output: new Uint8Array([2]) },
      } as AnyEventRequest);
    } else if (status === 'failed') {
      await create(runId, {
        eventType: 'run_failed',
        specVersion: SPEC,
        eventData: { error: new Uint8Array([3]), errorCode: 'USER_ERROR' },
      } as AnyEventRequest);
    } else {
      await create(runId, {
        eventType: 'run_cancelled',
        specVersion: SPEC,
      } as AnyEventRequest);
    }
  }

  /** Assert `error` is a refusal naming `holder` in `status`. */
  function expectRefusal(error: unknown, holder: string, status: string) {
    expect(isAlreadyStarted(error)).toBe(true);
    expect(error).toMatchObject({
      status: 409,
      code: 'idempotency-key-conflict',
      runId: holder,
      runStatus: status,
    });
  }

  /** Assert nothing was written for a refused run. */
  async function expectNotCreated(runs: Storage['runs'], runId: string) {
    await expect(runs.get(runId, { resolveData: 'none' })).rejects.toThrow();
  }

  async function expectHolder(
    runs: Storage['runs'],
    runId: string,
    key: string
  ) {
    const run = await runs.get(runId, { resolveData: 'none' });
    expect(run.runId).toBe(runId);
    expect(run.idempotencyKey).toBe(key);
  }

  const advance = async (ms: number) => {
    if (options.advanceClock) {
      await options.advanceClock(ms);
    } else {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  };

  describe(`run idempotency conformance (${options.name})`, () => {
    test('declares the run idempotency keys capability', () => {
      expect(options.capabilities()?.runIdempotencyKeys).toBe(true);
    });

    test(
      'creates the run, claims the key, and echoes it on the run and on reads',
      async () => {
        const events = options.events();
        const runs = options.runs();
        const key = uniqueKey();
        const { runId, result } = await claim(events, { key });

        expect(result.run?.runId).toBe(runId);
        expect(result.run?.status).toBe('pending');
        expect(result.run?.idempotencyKey).toBe(key);
        await expectHolder(runs, runId, key);
      },
      timeout
    );

    test(
      'leaves runs started without a key unaffected',
      async () => {
        const events = options.events();
        const runs = options.runs();
        const runId = options.newRunId();
        const result = await (events.create as CreateAny)(runId, {
          eventType: 'run_created',
          specVersion: SPEC,
          eventData: {
            deploymentId: 'dpl_idempotency_conformance',
            workflowName,
            input: new Uint8Array([1]),
          },
        } as AnyEventRequest);
        expect(result.run?.idempotencyKey).toBeUndefined();
        const run = await runs.get(runId, { resolveData: 'none' });
        expect(run.idempotencyKey).toBeUndefined();
      },
      timeout
    );

    test(
      "answers a re-post of the holder's own run id with EntityConflictError",
      async () => {
        const events = options.events();
        const runs = options.runs();
        const key = uniqueKey();
        const { runId } = await claim(events, { key });

        const again = await claimSettled(events, { key, runId });
        expect(isEntityConflict(again.error)).toBe(true);
        expect(isAlreadyStarted(again.error)).toBe(false);

        // Still a self-conflict after the holder starts running.
        await start(events, runId);
        const later = await claimSettled(events, { key, runId });
        expect(isEntityConflict(later.error)).toBe(true);
        expect(isAlreadyStarted(later.error)).toBe(false);
        await expectHolder(runs, runId, key);
      },
      timeout
    );

    for (const holderStatus of ['pending', 'running'] as const) {
      test(
        `refuses every policy while the holder is ${holderStatus}, and writes nothing`,
        async () => {
          const events = options.events();
          const runs = options.runs();
          const key = uniqueKey();
          const { runId: holder } = await claim(events, { key });
          if (holderStatus === 'running') await start(events, holder);

          for (const policy of POLICIES) {
            const refused = await claimSettled(events, {
              key,
              policy,
              // The shortest TTL changes nothing: an open holder always
              // keeps its key.
              ttlMs: IDEMPOTENCY_KEY_TTL_MIN_MS,
            });
            expectRefusal(refused.error, holder, holderStatus);
            await expectNotCreated(runs, refused.runId);
          }
          await expectHolder(runs, holder, key);
        },
        timeout
      );
    }

    for (const holderStatus of CLOSED_STATUSES) {
      for (const policy of POLICIES) {
        const takesOver = TAKEOVER_MATRIX[policy][holderStatus];
        test(
          `${takesOver ? 'takes over' : 'refuses'} a ${holderStatus} holder inside its window under ${policy}`,
          async () => {
            const events = options.events();
            const runs = options.runs();
            const key = uniqueKey();
            const { runId: holder } = await claim(events, { key });
            await close(events, holder, holderStatus);

            const next = await claimSettled(events, { key, policy });
            if (!takesOver) {
              expectRefusal(next.error, holder, holderStatus);
              await expectNotCreated(runs, next.runId);
              return;
            }

            expect(next.error).toBeUndefined();
            expect(next.result?.run?.runId).toBe(next.runId);
            expect(next.result?.run?.idempotencyKey).toBe(key);
            await expectHolder(runs, next.runId, key);
            // The key moved: the new (pending) run now holds it.
            const third = await claimSettled(events, {
              key,
              policy: 'ALLOW_DUPLICATE',
            });
            expectRefusal(third.error, next.runId, 'pending');
          },
          timeout
        );
      }
    }

    test(
      'lets exactly one of several concurrent claimers win a fresh key',
      async () => {
        const events = options.events();
        const runs = options.runs();
        const key = uniqueKey();
        const claimers = options.concurrentClaimers ?? 8;
        const outcomes = await Promise.all(
          Array.from({ length: claimers }, () => claimSettled(events, { key }))
        );

        const winners = outcomes.filter((o) => o.error === undefined);
        expect(winners).toHaveLength(1);
        const winner = winners[0].runId;
        for (const loser of outcomes.filter((o) => o.error !== undefined)) {
          expectRefusal(loser.error, winner, 'pending');
          await expectNotCreated(runs, loser.runId);
        }
        await expectHolder(runs, winner, key);
      },
      timeout
    );

    test(
      'lets exactly one of several concurrent claimers take a key over',
      async () => {
        const events = options.events();
        const runs = options.runs();
        const key = uniqueKey();
        const { runId: holder } = await claim(events, { key });
        await close(events, holder, 'completed');

        const claimers = options.concurrentClaimers ?? 8;
        const outcomes = await Promise.all(
          Array.from({ length: claimers }, () =>
            claimSettled(events, { key, policy: 'ALLOW_DUPLICATE' })
          )
        );

        const winners = outcomes.filter((o) => o.error === undefined);
        expect(winners).toHaveLength(1);
        const winner = winners[0].runId;
        expect(winner).not.toBe(holder);
        for (const loser of outcomes.filter((o) => o.error !== undefined)) {
          // Losers re-evaluate against the new, pending holder.
          expectRefusal(loser.error, winner, 'pending');
          await expectNotCreated(runs, loser.runId);
        }
        await expectHolder(runs, winner, key);
      },
      timeout
    );

    test(
      "frees the key once the holder's own window has passed since it closed",
      async () => {
        const events = options.events();
        const runs = options.runs();
        const shortKey = uniqueKey('short');
        const longKey = uniqueKey('long');
        const { runId: shortHolder } = await claim(events, {
          key: shortKey,
          ttlMs: IDEMPOTENCY_KEY_TTL_MIN_MS,
        });
        const { runId: longHolder } = await claim(events, {
          key: longKey,
          ttlMs: IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
        });
        await close(events, shortHolder, 'completed');
        await close(events, longHolder, 'completed');

        // Inside the window, REJECT_DUPLICATE still refuses.
        const early = await claimSettled(events, { key: shortKey });
        expectRefusal(early.error, shortHolder, 'completed');

        await advance(IDEMPOTENCY_KEY_TTL_MIN_MS + 500);

        const expired = await claimSettled(events, { key: shortKey });
        expect(expired.error).toBeUndefined();
        await expectHolder(runs, expired.runId, shortKey);

        // The holder's TTL applies, not the new caller's: a short TTL on the
        // new start does not shorten a long holder's window.
        const held = await claimSettled(events, {
          key: longKey,
          ttlMs: IDEMPOTENCY_KEY_TTL_MIN_MS,
        });
        expectRefusal(held.error, longHolder, 'completed');
      },
      timeout
    );

    test(
      'scopes keys by workflow name',
      async () => {
        const events = options.events();
        const runs = options.runs();
        const key = uniqueKey();
        const first = await claim(events, { key });
        const other = await claim(events, {
          key,
          workflowName: `${workflowName}_other`,
        });
        expect(other.runId).not.toBe(first.runId);
        await expectHolder(runs, first.runId, key);
        await expectHolder(runs, other.runId, key);
      },
      timeout
    );

    if (options.deleteRun) {
      const deleteRun = options.deleteRun;
      test(
        'treats a claim whose holder no longer exists as free',
        async () => {
          const events = options.events();
          const runs = options.runs();
          const key = uniqueKey();
          const { runId: holder } = await claim(events, { key });
          await deleteRun(holder);

          // Even REJECT_DUPLICATE, and even though the holder never closed.
          const next = await claimSettled(events, { key });
          expect(next.error).toBeUndefined();
          await expectHolder(runs, next.runId, key);
        },
        timeout
      );
    }
  });
}
