import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import type {
  AnyEventRequest,
  CreateEventParams,
  EventResult,
} from '../events.js';
import type { Hook } from '../hooks.js';
import type { Storage, WorldCapabilities } from '../interfaces.js';
import { SPEC_VERSION_CURRENT } from '../spec-version.js';
import {
  START_HOOK_ADMISSION_REJECTED_CODE,
  START_HOOK_CANDIDATE_MAX_AGE_MS,
  type StartHook,
} from '../start-hook.js';

/**
 * Conformance for atomic start Hook admission (see `start-hook.ts` and
 * `WorldCapabilities.atomicStartHook`).
 *
 * What every World that implements it must agree on, whatever it stores the
 * reservation in:
 *
 * - It declares `capabilities.atomicStartHook`.
 * - An accepted candidate's run is created with the reservation echoed on
 *   `run.startHook`, and re-posting either creating write for it returns
 *   that run.
 * - A refused candidate gets `HookConflictError` naming the owner, creates no
 *   run, and keeps getting the same owner on every later attempt, through
 *   either path, even after the token is free.
 * - Of concurrent candidates for one token, exactly one is accepted.
 * - The direct `run_created` and the queued `run_started` of one candidate,
 *   racing, create one run with one `run_created`.
 * - The token is held until the owner run ends, and after that until the
 *   retention passes.
 * - The owner's own `createHook()` with the token adopts the reservation; any
 *   other run's conflicts with the owner; disposing the adopted Hook does not
 *   release the token while the owner runs.
 * - A by-token lookup before adoption throws `HookReservedError` naming the
 *   owner, and answers not found once the owner ended without adopting, or
 *   after the adopted Hook was disposed.
 * - An adoption without metadata takes the reservation's; its own wins.
 * - A forced `createHook()` cannot take a reservation that has no Hook, and
 *   taking its adopted Hook moves the reservation to the claimer.
 * - A retention beyond the World's limit is refused with
 *   `START_HOOK_ADMISSION_REJECTED`.
 * - Past the 24h orphan bound, a candidate with no run is refused with
 *   `START_HOOK_ADMISSION_REJECTED` through either copy, and a staged
 *   orphan (an accepted candidate whose run was never created) no longer
 *   holds its token.
 *
 * Import it from a World's own test file (by relative path, like the other
 * test-support modules) and call it at module level.
 */
export interface AtomicStartHookConformanceOptions {
  /** Describe-block name, usually the World's name. */
  name: string;
  /** The storage under test. Called once per test. */
  storage: () => Pick<Storage, 'events' | 'runs' | 'hooks'>;
  /** The capabilities the World under test declares (`World.capabilities`). */
  capabilities: () => WorldCapabilities | undefined;
  /** A fresh client-minted run id (`wrun_<ulid>`). */
  newRunId: () => string;
  /**
   * A second events storage over the same backing data as the one passed in
   * (another instance on the same data directory or database), so racing
   * writers can come from different instances, as the direct and queued
   * copies of a start do. Omit when the World cannot have two instances.
   */
  secondEvents?: (first: Storage['events']) => Storage['events'];
  /** How many concurrent candidates to race. Defaults to 8. */
  concurrentCandidates?: number;
  /**
   * Moves the clock the World's admission reads (its `Date.now()`) forward,
   * so the 24h orphan bound can be crossed in virtual time. The suite calls
   * it with `0` after each test to restore real time. Omit to skip the
   * orphan-bound cases.
   */
  advanceClock?: (ms: number) => void;
  /**
   * Leaves the state a writer that died mid-admission leaves behind: the
   * candidate accepted (its token reserved) but its run never created. Omit
   * for a World where that state cannot exist (one that reserves the token
   * and creates the run in a single transaction).
   */
  stageOrphan?: (runId: string, token: string) => Promise<void>;
  /**
   * Whether a staged orphan keeps its token until the 24h bound passes. A
   * World may release earlier when the orphan was never observed as
   * admitted (no caller saw its run): world-local does.
   */
  orphanHoldsWithinWindow?: boolean;
}

const SPEC = SPEC_VERSION_CURRENT;

/**
 * `@workflow/world` cannot depend on `@workflow/errors`, so errors are
 * recognized the way their own `is()` guards do it: by name.
 */
function errorNamed(value: unknown, name: string): boolean {
  return value instanceof Error && value.name === name;
}

/** `create` without its overloads, so a test can pass any request. */
type CreateAny = (
  runId: string | null,
  data: AnyEventRequest,
  params?: CreateEventParams
) => Promise<EventResult>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function atomicStartHookConformance(
  options: AtomicStartHookConformanceOptions
): void {
  // The runs and hooks storage of the current test's storage; see `setup`.
  let runs: Storage['runs'];
  let hooks: Storage['hooks'];
  const setup = (): Storage['events'] => {
    const storage = options.storage();
    runs = storage.runs;
    hooks = storage.hooks;
    return storage.events;
  };

  const create = (
    events: Storage['events'],
    runId: string,
    data: AnyEventRequest
  ) => (events.create as CreateAny)(runId, data);

  const lookup = (token: string): Promise<{ hook?: Hook; error?: unknown }> =>
    hooks.getByToken(token).then(
      (hook) => ({ hook }),
      (error: unknown) => ({ error })
    );

  const runData = (startHook: StartHook) => ({
    deploymentId: 'dpl_start_hook_conformance',
    workflowName: 'startHookConformance',
    input: new Uint8Array([1]),
    startHook,
  });

  const runCreated = (startHook: StartHook) =>
    ({
      eventType: 'run_created',
      specVersion: SPEC,
      eventData: runData(startHook),
    }) as AnyEventRequest;

  const runStarted = (startHook: StartHook) =>
    ({
      eventType: 'run_started',
      specVersion: SPEC,
      eventData: runData(startHook),
    }) as AnyEventRequest;

  /** A plain run (no start Hook), already running. */
  async function plainRun(events: Storage['events']): Promise<string> {
    const runId = options.newRunId();
    await create(events, runId, {
      eventType: 'run_created',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_start_hook_conformance',
        workflowName: 'startHookConformance',
        input: new Uint8Array([1]),
      },
    } as AnyEventRequest);
    await create(events, runId, {
      eventType: 'run_started',
      specVersion: SPEC,
    } as AnyEventRequest);
    return runId;
  }

  async function admit(
    events: Storage['events'],
    startHook: StartHook
  ): Promise<string> {
    const runId = options.newRunId();
    const result = await create(events, runId, runCreated(startHook));
    expect(result.run?.runId).toBe(runId);
    return runId;
  }

  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => {
        throw new Error('expected the candidate to be refused');
      },
      (error: unknown) => error
    );
  }

  async function expectRefused(
    promise: Promise<unknown>,
    token: string,
    conflictingRunId: string
  ): Promise<void> {
    const error = await refusal(promise);
    expect(errorNamed(error, 'HookConflictError')).toBe(true);
    expect(error).toMatchObject({ token, conflictingRunId });
  }

  async function runExists(runId: string): Promise<boolean> {
    return runs.get(runId).then(
      () => true,
      () => false
    );
  }

  async function finish(events: Storage['events'], runId: string) {
    const run = await runs.get(runId);
    if (run.status === 'pending') {
      await create(events, runId, {
        eventType: 'run_started',
        specVersion: SPEC,
      } as AnyEventRequest);
    }
    await create(events, runId, {
      eventType: 'run_completed',
      specVersion: SPEC,
      eventData: { output: new Uint8Array([2]) },
    } as AnyEventRequest);
  }

  const hookCreated = (token: string, hookId: string, force?: boolean) =>
    ({
      eventType: 'hook_created',
      correlationId: hookId,
      specVersion: SPEC,
      eventData: { token, ...(force ? { force: true } : {}) },
    }) as AnyEventRequest;

  const hookDisposed = (token: string, hookId: string) =>
    ({
      eventType: 'hook_disposed',
      correlationId: hookId,
      specVersion: SPEC,
      eventData: { token },
    }) as AnyEventRequest;

  const newToken = () => `start-hook-conformance:${randomUUID()}`;
  const newHookId = () => `hook_${randomUUID().replaceAll('-', '')}`;

  describe(`atomic start Hook conformance (${options.name})`, () => {
    test('declares the atomic start Hook capability', () => {
      expect(options.capabilities()?.atomicStartHook?.active).toBe(true);
    });

    test('admits a candidate, echoes the reservation, and replays it for both paths', async () => {
      const events = setup();
      const token = newToken();
      const runId = options.newRunId();

      const first = await create(events, runId, runCreated({ token }));
      expect(first.run?.runId).toBe(runId);
      expect(first.run?.startHook?.token).toBe(token);

      // A retry of the direct write, and the queued copy, both get the run.
      const again = await create(events, runId, runCreated({ token }));
      expect(again.run?.runId).toBe(runId);
      const started = await create(events, runId, runStarted({ token }));
      expect(started.run?.status).toBe('running');

      // The reservation survives the run's status transitions: a late retry
      // of the direct write still finds its own run.
      expect((await runs.get(runId)).startHook?.token).toBe(token);
      const late = await create(events, runId, runCreated({ token }));
      expect(late.run?.runId).toBe(runId);

      const log = await events.list({ runId });
      expect(
        log.data.filter((event) => event.eventType === 'run_created')
      ).toHaveLength(1);
    });

    test('refuses a duplicate with the owner, creates nothing, and keeps the decision', async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      const candidate = options.newRunId();

      await expectRefused(
        create(events, candidate, runCreated({ token })),
        token,
        owner
      );
      expect(await runExists(candidate)).toBe(false);

      // The same decision through either path.
      await expectRefused(
        create(events, candidate, runCreated({ token })),
        token,
        owner
      );
      await expectRefused(
        create(events, candidate, runStarted({ token })),
        token,
        owner
      );

      // Still refused, naming the same owner, after the token is free.
      await finish(events, owner);
      await expectRefused(
        create(events, candidate, runStarted({ token })),
        token,
        owner
      );
      expect(await runExists(candidate)).toBe(false);
    });

    test('admits exactly one of several concurrent candidates', async () => {
      const first = setup();
      const second = options.secondEvents?.(first) ?? first;
      const token = newToken();
      const count = options.concurrentCandidates ?? 8;
      const candidates = Array.from({ length: count }, () =>
        options.newRunId()
      );

      const results = await Promise.allSettled(
        candidates.map((runId, i) =>
          create(
            i % 2 === 0 ? first : second,
            runId,
            i % 4 < 2 ? runCreated({ token }) : runStarted({ token })
          )
        )
      );

      const accepted = candidates.filter(
        (_, i) => results[i].status === 'fulfilled'
      );
      expect(accepted).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(errorNamed(result.reason, 'HookConflictError')).toBe(true);
          expect(result.reason).toMatchObject({
            conflictingRunId: accepted[0],
          });
        }
      }
      for (const runId of candidates) {
        expect(await runExists(runId)).toBe(runId === accepted[0]);
      }
    });

    test('the direct and queued writes of one candidate create one run', async () => {
      const first = setup();
      const second = options.secondEvents?.(first) ?? first;
      const token = newToken();
      const runId = options.newRunId();

      const [direct, queued] = await Promise.allSettled([
        create(first, runId, runCreated({ token })),
        create(second, runId, runStarted({ token })),
      ]);
      expect(direct.status === 'rejected' ? direct.reason : 'ok').toBe('ok');
      expect(queued.status === 'rejected' ? queued.reason : 'ok').toBe('ok');

      const log = await first.list({ runId });
      expect(
        log.data.filter((event) => event.eventType === 'run_created')
      ).toHaveLength(1);
      expect((await runs.get(runId)).status).toBe('running');
    });

    test('holds the token until the owner ends', async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });

      await expectRefused(admit(events, { token }), token, owner);
      await finish(events, owner);
      await admit(events, { token });
    });

    test('holds the token past the owner end until the retention passes', async () => {
      const events = setup();
      const token = newToken();
      const retentionMs = 2_000;
      const owner = await admit(events, {
        token,
        tokenRetentionUntil: new Date(Date.now() + retentionMs),
      });
      await finish(events, owner);

      await expectRefused(admit(events, { token }), token, owner);
      await sleep(retentionMs + 250);
      await admit(events, { token });
    });

    test("the owner's createHook adopts the reservation, and another run's conflicts", async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      await create(events, owner, runStarted({ token }));

      const hookId = newHookId();
      const adopted = await create(events, owner, hookCreated(token, hookId));
      expect(adopted.event?.eventType).toBe('hook_created');

      const other = await plainRun(events);
      const conflict = await create(
        events,
        other,
        hookCreated(token, newHookId())
      );
      expect(conflict.event?.eventType).toBe('hook_conflict');
      expect(conflict.event?.eventData).toMatchObject({
        conflictingRunId: owner,
      });

      // Disposing the adopted Hook does not release the reservation while
      // the owner runs.
      await create(events, owner, hookDisposed(token, hookId));
      await expectRefused(admit(events, { token }), token, owner);
      const stillConflicts = await create(
        events,
        other,
        hookCreated(token, newHookId())
      );
      expect(stillConflicts.event?.eventType).toBe('hook_conflict');

      await finish(events, owner);
      await admit(events, { token });
    });

    test('an adopted Hook retention extends the reservation past its disposal', async () => {
      const events = setup();
      const token = newToken();
      const retentionMs = 2_000;
      const owner = await admit(events, { token });
      await create(events, owner, runStarted({ token }));

      // Adopt with a retention, dispose, adopt again with none.
      const first = newHookId();
      await create(events, owner, {
        ...hookCreated(token, first),
        eventData: {
          token,
          tokenRetentionUntil: new Date(Date.now() + retentionMs),
        },
      } as AnyEventRequest);
      await create(events, owner, hookDisposed(token, first));
      const second = await create(
        events,
        owner,
        hookCreated(token, newHookId())
      );
      expect(second.event?.eventType).toBe('hook_created');

      await finish(events, owner);
      await expectRefused(admit(events, { token }), token, owner);
      await sleep(retentionMs + 250);
      await admit(events, { token });
    });

    test('a lookup before adoption is HookReservedError, and not found once the owner ends without adopting', async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      await create(events, owner, runStarted({ token }));

      const reserved = await lookup(token);
      expect(errorNamed(reserved.error, 'HookReservedError')).toBe(true);
      expect(errorNamed(reserved.error, 'HookNotFoundError')).toBe(false);
      expect(reserved.error).toMatchObject({ token, runId: owner });

      await finish(events, owner);
      expect(errorNamed((await lookup(token)).error, 'HookNotFoundError')).toBe(
        true
      );
    });

    test('a lookup after adoption finds the Hook, and not found once it is disposed', async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      await create(events, owner, runStarted({ token }));
      const hookId = newHookId();
      await create(events, owner, hookCreated(token, hookId));

      expect((await lookup(token)).hook?.runId).toBe(owner);

      await create(events, owner, hookDisposed(token, hookId));
      expect(errorNamed((await lookup(token)).error, 'HookNotFoundError')).toBe(
        true
      );
      // Still reserved for admission while the owner runs.
      await expectRefused(admit(events, { token }), token, owner);
    });

    test("the reservation's metadata carries over to an adoption that brings none", async () => {
      const events = setup();
      const token = newToken();
      const metadata = new Uint8Array([1, 2, 3]);
      const owner = await admit(events, { token, metadata });
      await create(events, owner, runStarted({ token }));
      await create(events, owner, hookCreated(token, newHookId()));

      const { hook } = await lookup(token);
      expect(hook?.metadata).toEqual(metadata);
    });

    test("an adoption's own metadata wins over the reservation's", async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, {
        token,
        metadata: new Uint8Array([1, 2, 3]),
      });
      await create(events, owner, runStarted({ token }));
      const own = new Uint8Array([9, 9]);
      await create(events, owner, {
        ...hookCreated(token, newHookId()),
        eventData: { token, metadata: own },
      } as AnyEventRequest);

      const { hook } = await lookup(token);
      expect(hook?.metadata).toEqual(own);
    });

    test('a forced createHook cannot take a reservation with no Hook', async () => {
      if (!options.capabilities()?.hookForceClaim) return;
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      await create(events, owner, runStarted({ token }));

      const claimer = await plainRun(events);
      const result = await create(
        events,
        claimer,
        hookCreated(token, newHookId(), true)
      );
      expect(result.event?.eventType).toBe('hook_conflict');
      expect(result.event?.eventData).toMatchObject({
        conflictingRunId: owner,
      });
    });

    test('a forced createHook that takes the materialized Hook takes the reservation with it', async () => {
      if (!options.capabilities()?.hookForceClaim) return;
      const events = setup();
      const token = newToken();
      const source = await admit(events, { token });
      await create(events, source, runStarted({ token }));
      await create(events, source, hookCreated(token, newHookId()));

      const successor = await plainRun(events);
      const successorHookId = newHookId();
      const claimed = await create(
        events,
        successor,
        hookCreated(token, successorHookId, true)
      );
      expect(claimed.event?.eventType).toBe('hook_created');

      // The source stays parked (never ends). The successor now holds the
      // reservation: disposing its Hook does not release the token...
      await create(events, successor, hookDisposed(token, successorHookId));
      await expectRefused(admit(events, { token }), token, successor);
      // ...and ending it does, though the source is still running.
      await finish(events, successor);
      await admit(events, { token });
    });

    describe('orphan bound', () => {
      const DAY_MS = START_HOOK_CANDIDATE_MAX_AGE_MS;
      const advance = options.advanceClock;
      afterEach(() => advance?.(0));
      const orphanTest = advance ? test : test.skip;
      const stagedOrphanTest =
        advance && options.stageOrphan ? test : test.skip;

      orphanTest(
        'refuses a candidate past the bound that never got a run, through either copy',
        async () => {
          const events = setup();
          const token = newToken();
          const late = options.newRunId();
          advance?.(DAY_MS + 60_000);

          for (const request of [
            runStarted({ token }),
            runCreated({ token }),
          ]) {
            const error = await refusal(create(events, late, request));
            expect(errorNamed(error, 'WorkflowWorldError')).toBe(true);
            expect(error).toMatchObject({
              code: START_HOOK_ADMISSION_REJECTED_CODE,
            });
          }
          expect(await runExists(late)).toBe(false);
          // The refusal reserved nothing.
          await admit(events, { token });
        }
      );

      stagedOrphanTest(
        options.orphanHoldsWithinWindow
          ? 'an orphan holds its token within the bound and releases it after'
          : 'an orphan never seen as admitted does not hold its token',
        async () => {
          const events = setup();
          const token = newToken();
          const orphan = options.newRunId();
          await options.stageOrphan?.(orphan, token);

          if (options.orphanHoldsWithinWindow) {
            await expectRefused(admit(events, { token }), token, orphan);
            advance?.(DAY_MS + 60_000);
          }
          // A contender owns the token now.
          const contender = await admit(events, { token });
          expect(await runExists(contender)).toBe(true);
          expect(await runExists(orphan)).toBe(false);
        }
      );

      stagedOrphanTest(
        "refuses the orphan's own attempt past the bound",
        async () => {
          const events = setup();
          const token = newToken();
          const orphan = options.newRunId();
          await options.stageOrphan?.(orphan, token);
          advance?.(DAY_MS + 60_000);

          const error = await refusal(
            create(events, orphan, runStarted({ token }))
          );
          expect(error).toMatchObject({
            code: START_HOOK_ADMISSION_REJECTED_CODE,
          });
          expect(await runExists(orphan)).toBe(false);
          await admit(events, { token });
        }
      );
    });

    test('refuses a retention beyond the World limit as a permanent rejection', async () => {
      const events = setup();
      const error = await refusal(
        admit(events, {
          token: newToken(),
          tokenRetentionUntil: new Date(Date.now() + 400 * 24 * 3600_000),
        })
      );
      expect(errorNamed(error, 'WorkflowWorldError')).toBe(true);
      expect(error).toMatchObject({ code: START_HOOK_ADMISSION_REJECTED_CODE });
    });
  });
}
