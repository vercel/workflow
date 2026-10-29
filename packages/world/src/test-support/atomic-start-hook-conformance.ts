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
  START_HOOK_CANDIDATE_CANCELLED_CODE,
  START_HOOK_CANDIDATE_MAX_AGE_MS,
  type StartHook,
  startHookId,
} from '../start-hook.js';

/**
 * Conformance for atomic start Hook admission (see `start-hook.ts` and
 * `WorldCapabilities.atomicStartHook`).
 *
 * What every World that implements it must agree on, whatever it stores the
 * start Hook in:
 *
 * - It declares `capabilities.atomicStartHook`.
 * - An accepted candidate's run is created with the start Hook echoed on
 *   `run.startHook` (with `hookId`, on `run_created`, `runs.get` and
 *   `run_started`), and re-posting either creating write for it returns that
 *   run.
 * - A refused candidate gets `HookConflictError` naming the owner, creates no
 *   run, and keeps getting the same owner on every later attempt, through
 *   either path, even after the token is free.
 * - Of concurrent candidates for one token, exactly one is accepted.
 * - The direct `run_created` and the queued `run_started` of one candidate,
 *   racing, create one run with one `run_created`.
 * - The admission creates the Hook `startHookId(runId)`: resolvable by token
 *   and by id, and resumable, as soon as `run_created` returns, while the run
 *   is still pending; no `hook_created` is written for it, and a
 *   `hook_created` with its id is refused (400).
 * - It follows the ordinary Hook lifecycle: other runs' `createHook()`
 *   conflict naming the owner (and so does the owner's own second one while
 *   it is live); disposal frees the token at once, even with a retention;
 *   the owner's end frees it, unless the retention is still running, in
 *   which case the Hook stays readable, refuses deliveries and holds the
 *   token until then; the owner may create a Hook on the token again after
 *   disposing it.
 * - A forced `createHook()` takes it like any Hook, even before the workflow
 *   opens it: the owner's log gets `hook_disposed{forceClaimedBy}` for
 *   `startHookId(owner)`.
 * - A retention beyond the World's limit is refused with
 *   `START_HOOK_ADMISSION_REJECTED`.
 * - Past the 24h orphan bound, a candidate with no run is refused with
 *   `START_HOOK_ADMISSION_REJECTED` through either copy, and a decided
 *   candidate's `run_created` is too. A staged orphan (an accepted candidate
 *   whose run was never created) holds its token for the World's hold and
 *   releases it after, resolves as not found and takes no resumes, and its
 *   own later copies are then refused naming the run that took the token.
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
   * candidate accepted (its token claimed) but its run never created. Omit
   * for a World where that state cannot exist (one that claims the token
   * and creates the run in a single transaction).
   */
  stageOrphan?: (runId: string, token: string) => Promise<void>;
  /**
   * How long a staged orphan keeps its token before a contender may take it:
   * the 24h bound for a World that records an acceptance before the run
   * (the Vercel backend), or a shorter grace for one whose acceptance is the
   * run itself (world-local holds for its claim lock's lease plus margin, in
   * case the writer is stalled rather than dead). Defaults to 24h.
   */
  orphanHoldMs?: number;
  /**
   * A known gap, stated in place of the test it skips: why an admission
   * racing another run's concurrent `createHook()` for the same token can
   * leave two owners in this World. Omit (the default) to run that test.
   */
  knownGapAdmissionVsConcurrentCreateHook?: string;
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

  const hookReceived = (token: string, hookId: string, payload: number) =>
    ({
      eventType: 'hook_received',
      correlationId: hookId,
      specVersion: SPEC,
      eventData: { token, payload: new Uint8Array([payload]) },
    }) as AnyEventRequest;

  const newToken = () => `start-hook-conformance:${randomUUID()}`;
  const newHookId = () => `hook_${randomUUID().replaceAll('-', '')}`;

  describe(`atomic start Hook conformance (${options.name})`, () => {
    test('declares the atomic start Hook capability', () => {
      expect(options.capabilities()?.atomicStartHook?.active).toBe(true);
    });

    test('admits a candidate, echoes the start Hook, and replays it for both paths', async () => {
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

      // The echo survives the run's status transitions: a late retry
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

    (options.knownGapAdmissionVsConcurrentCreateHook ? test.skip : test)(
      "another run's concurrent createHook and an admission leave one owner",
      async () => {
        const first = setup();
        const second = options.secondEvents?.(first) ?? first;
        for (let round = 0; round < 4; round++) {
          const token = newToken();
          const other = await plainRun(first);
          const candidate = options.newRunId();
          const [admission, created] = await Promise.allSettled([
            create(
              round % 2 === 0 ? first : second,
              candidate,
              runCreated({ token })
            ),
            create(first, other, hookCreated(token, newHookId())),
          ]);
          expect(created.status).toBe('fulfilled');
          const hookWon =
            created.status === 'fulfilled' &&
            created.value.event?.eventType === 'hook_created';
          if (hookWon) {
            // The Hook owns the token: the candidate was refused naming it.
            expect(admission.status).toBe('rejected');
            if (admission.status === 'rejected') {
              expect(errorNamed(admission.reason, 'HookConflictError')).toBe(
                true
              );
              expect(admission.reason).toMatchObject({
                conflictingRunId: other,
              });
            }
            expect(await runExists(candidate)).toBe(false);
          } else {
            // The start Hook owns it: the Hook creation conflicted with it.
            expect(admission.status).toBe('fulfilled');
            expect(
              created.status === 'fulfilled' && created.value.event?.eventData
            ).toMatchObject({ conflictingRunId: candidate });
          }
        }
      }
    );

    test("an admission racing the owner's end leaves exactly one owner", async () => {
      const first = setup();
      const second = options.secondEvents?.(first) ?? first;
      for (let round = 0; round < 4; round++) {
        const token = newToken();
        const owner = await admit(first, { token });
        await create(first, owner, runStarted({ token }));
        const candidate = options.newRunId();

        const [, admission] = await Promise.allSettled([
          finish(first, owner),
          create(
            round % 2 === 0 ? second : first,
            candidate,
            runCreated({ token })
          ),
        ]);

        if (admission.status === 'rejected') {
          // Decided while the owner still ran: refused naming it, and the
          // token is free now that it has ended.
          expect(errorNamed(admission.reason, 'HookConflictError')).toBe(true);
          expect(admission.reason).toMatchObject({ conflictingRunId: owner });
          expect(await runExists(candidate)).toBe(false);
          await admit(first, { token });
        } else {
          // Decided after the end: the candidate owns the token.
          await expectRefused(admit(first, { token }), token, candidate);
        }
      }
    });

    test('an admission racing the end of an owner with retention is refused', async () => {
      const first = setup();
      const second = options.secondEvents?.(first) ?? first;
      const token = newToken();
      const owner = await admit(first, {
        token,
        tokenRetentionUntil: new Date(Date.now() + 60_000),
      });
      await create(first, owner, runStarted({ token }));
      const candidate = options.newRunId();

      const [, admission] = await Promise.allSettled([
        finish(first, owner),
        create(second, candidate, runCreated({ token })),
      ]);

      expect(admission.status).toBe('rejected');
      if (admission.status === 'rejected') {
        expect(admission.reason).toMatchObject({ conflictingRunId: owner });
      }
      expect(await runExists(candidate)).toBe(false);
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

    test('the admission creates the start Hook: resolvable at once, before the run starts', async () => {
      const events = setup();
      const token = newToken();
      const metadata = new Uint8Array([1, 2, 3]);
      const owner = await admit(events, { token, metadata });
      const hookId = startHookId(owner);

      // Right after run_created returns, with the run still pending.
      expect((await runs.get(owner)).status).toBe('pending');
      const byToken = await lookup(token);
      expect(byToken.error).toBeUndefined();
      expect(byToken.hook).toMatchObject({
        hookId,
        runId: owner,
        token,
        isWebhook: false,
      });
      expect(byToken.hook?.metadata).toEqual(metadata);
      const byId = await hooks.get(hookId);
      expect(byId).toMatchObject({ hookId, runId: owner, token });

      // No hook_created for it: run_created stands for its creation.
      const log = await events.list({ runId: owner });
      expect(
        log.data.some(
          (event) =>
            event.eventType === 'hook_created' && event.correlationId === hookId
        )
      ).toBe(false);
    });

    test('run.startHook names the start Hook on run_created, runs.get and run_started', async () => {
      const events = setup();
      const token = newToken();
      const runId = options.newRunId();
      const hookId = startHookId(runId);

      const created = await create(events, runId, runCreated({ token }));
      expect(created.run?.startHook).toMatchObject({ token, hookId });
      expect((await runs.get(runId)).startHook).toMatchObject({
        token,
        hookId,
      });
      const started = await create(events, runId, runStarted({ token }));
      expect(started.run?.startHook).toMatchObject({ token, hookId });

      // The stored run_created keeps the token and id, for replay.
      const log = await events.list({ runId });
      const first = log.data.find((event) => event.eventType === 'run_created');
      expect(
        (first?.eventData as { startHook?: unknown } | undefined)?.startHook
      ).toMatchObject({ token, hookId });
    });

    test('a resume lands on the start Hook at once, while the run is pending and after it starts', async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      const hookId = startHookId(owner);

      const pending = await create(
        events,
        owner,
        hookReceived(token, hookId, 1)
      );
      expect(pending.event?.eventType).toBe('hook_received');
      await create(events, owner, runStarted({ token }));
      const running = await create(
        events,
        owner,
        hookReceived(token, hookId, 2)
      );
      expect(running.event?.eventType).toBe('hook_received');

      const log = await events.list({ runId: owner });
      expect(log.data[0]?.eventType).toBe('run_created');
      expect(
        log.data.filter(
          (event) =>
            event.eventType === 'hook_received' &&
            event.correlationId === hookId
        )
      ).toHaveLength(2);
    });

    test('a hook_created with the start Hook id is refused as invalid', async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      await create(events, owner, runStarted({ token }));

      const error = await refusal(
        create(events, owner, hookCreated(token, startHookId(owner)))
      );
      expect((error as { status?: unknown }).status).toBe(400);
      // The start Hook is untouched.
      expect((await lookup(token)).hook?.hookId).toBe(startHookId(owner));
    });

    test("another run's createHook conflicts naming the owner, and so does the owner's own second one", async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      await create(events, owner, runStarted({ token }));

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

      // While the start Hook is live, the same token is taken in its own run
      // too, as for any Hook.
      const own = await create(events, owner, hookCreated(token, newHookId()));
      expect(own.event?.eventType).toBe('hook_conflict');
      expect(own.event?.eventData).toMatchObject({ conflictingRunId: owner });
    });

    test('disposing the start Hook frees the token at once, even with a retention', async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, {
        token,
        tokenRetentionUntil: new Date(Date.now() + 3_600_000),
      });
      await create(events, owner, runStarted({ token }));

      await create(events, owner, hookDisposed(token, startHookId(owner)));
      expect(errorNamed((await lookup(token)).error, 'HookNotFoundError')).toBe(
        true
      );
      // The owner still runs, and the token is free.
      const next = await admit(events, { token });
      expect((await lookup(token)).hook?.runId).toBe(next);
    });

    test('after disposing the start Hook, the owner may create a Hook on the token again', async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      await create(events, owner, runStarted({ token }));
      await create(events, owner, hookDisposed(token, startHookId(owner)));

      const hookId = newHookId();
      const again = await create(events, owner, hookCreated(token, hookId));
      expect(again.event?.eventType).toBe('hook_created');
      expect((await lookup(token)).hook).toMatchObject({
        hookId,
        runId: owner,
      });
      await expectRefused(admit(events, { token }), token, owner);
    });

    test('after disposing the start Hook, a re-create conflicts naming the run that took the token', async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      await create(events, owner, runStarted({ token }));
      await create(events, owner, hookDisposed(token, startHookId(owner)));

      const other = await plainRun(events);
      const taken = await create(
        events,
        other,
        hookCreated(token, newHookId())
      );
      expect(taken.event?.eventType).toBe('hook_created');
      const again = await create(
        events,
        owner,
        hookCreated(token, newHookId())
      );
      expect(again.event?.eventType).toBe('hook_conflict');
      expect(again.event?.eventData).toMatchObject({ conflictingRunId: other });
    });

    test("the owner's end frees the start Hook and its token", async () => {
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      await finish(events, owner);

      expect(errorNamed((await lookup(token)).error, 'HookNotFoundError')).toBe(
        true
      );
      await refusal(
        create(events, owner, hookReceived(token, startHookId(owner), 1))
      );
      await admit(events, { token });
    });

    test('with a retention, the ended owner keeps a readable Hook that takes no deliveries', async () => {
      const events = setup();
      const token = newToken();
      const until = Date.now() + 3_000;
      const owner = await admit(events, {
        token,
        tokenRetentionUntil: new Date(until),
      });
      await finish(events, owner);

      expect((await lookup(token)).hook).toMatchObject({
        hookId: startHookId(owner),
        runId: owner,
      });
      await refusal(
        create(events, owner, hookReceived(token, startHookId(owner), 1))
      );
      await expectRefused(admit(events, { token }), token, owner);
      const other = await plainRun(events);
      const conflict = await create(
        events,
        other,
        hookCreated(token, newHookId())
      );
      expect(conflict.event?.eventData).toMatchObject({
        conflictingRunId: owner,
      });

      await sleep(Math.max(0, until - Date.now()) + 250);
      await admit(events, { token });
    });

    test.each([
      ['a running owner', true],
      ['an owner that has not started', false],
    ])('a forced createHook takes the start Hook of %s like any Hook', async (_label, started) => {
      if (!options.capabilities()?.hookForceClaim) return;
      const events = setup();
      const token = newToken();
      const owner = await admit(events, { token });
      if (started) await create(events, owner, runStarted({ token }));

      const claimer = await plainRun(events);
      const claimerHookId = newHookId();
      const claimed = await create(
        events,
        claimer,
        hookCreated(token, claimerHookId, true)
      );
      expect(claimed.event?.eventType).toBe('hook_created');
      expect((await lookup(token)).hook).toMatchObject({
        hookId: claimerHookId,
        runId: claimer,
      });

      // The owner's log is told, against the start Hook's id.
      const log = await events.list({ runId: owner });
      expect(log.data[0]?.eventType).toBe('run_created');
      const disposed = log.data.find(
        (event) =>
          event.eventType === 'hook_disposed' &&
          event.correlationId === startHookId(owner)
      );
      expect(disposed?.eventData).toMatchObject({
        forceClaimedBy: { runId: claimer, hookId: claimerHookId },
      });
      await expectRefused(admit(events, { token }), token, claimer);
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
          // The refusal claimed nothing.
          await admit(events, { token });
        }
      );

      orphanTest(
        "refuses a decided candidate's run_created past the bound, accepted or refused",
        async () => {
          const events = setup();
          const token = newToken();
          const accepted = await admit(events, { token });
          const refused = options.newRunId();
          await expectRefused(
            create(events, refused, runCreated({ token })),
            token,
            accepted
          );
          advance?.(DAY_MS + 60_000);

          // The bound answers first: start() only ever retries with a new
          // candidate, so nothing waits on these decisions past it.
          for (const runId of [accepted, refused]) {
            const error = await refusal(
              create(events, runId, runCreated({ token }))
            );
            expect(errorNamed(error, 'WorkflowWorldError')).toBe(true);
            expect(error).toMatchObject({
              code: START_HOOK_ADMISSION_REJECTED_CODE,
            });
          }
        }
      );

      stagedOrphanTest(
        'an orphan holds its token for its hold, and a contender owns it after',
        async () => {
          const events = setup();
          const token = newToken();
          const orphan = options.newRunId();
          const holdMs = options.orphanHoldMs ?? DAY_MS;
          await options.stageOrphan?.(orphan, token);

          // Just inside the hold: refused, naming the orphan.
          advance?.(holdMs - 5_000);
          await expectRefused(admit(events, { token }), token, orphan);
          // Just past it: a contender owns the token.
          advance?.(10_000);
          const contender = await admit(events, { token });
          expect(await runExists(contender)).toBe(true);
          expect(await runExists(orphan)).toBe(false);
          // The orphan's own late copies can never create it now: refused
          // naming the contender, or, for a World whose hold is the orphan
          // bound itself, by the bound.
          const late = create(events, orphan, runStarted({ token }));
          if (holdMs < DAY_MS) {
            await expectRefused(late, token, contender);
          } else {
            expect(await refusal(late)).toMatchObject({
              code: START_HOOK_ADMISSION_REJECTED_CODE,
            });
          }
          expect(await runExists(orphan)).toBe(false);
        }
      );

      stagedOrphanTest(
        'an orphan resolves as not found and takes no resumes, during its hold and after',
        async () => {
          const events = setup();
          const token = newToken();
          const orphan = options.newRunId();
          const holdMs = options.orphanHoldMs ?? DAY_MS;
          await options.stageOrphan?.(orphan, token);
          const resume = () =>
            refusal(
              create(
                events,
                orphan,
                hookReceived(token, startHookId(orphan), 1)
              )
            );

          advance?.(holdMs - 5_000);
          expect(
            errorNamed((await lookup(token)).error, 'HookNotFoundError')
          ).toBe(true);
          await resume();

          advance?.(10_000);
          expect(
            errorNamed((await lookup(token)).error, 'HookNotFoundError')
          ).toBe(true);
          await resume();
          expect(await runExists(orphan)).toBe(false);
        }
      );

      stagedOrphanTest(
        'cancelling a candidate that never became a run keeps it from ever becoming one',
        async () => {
          const events = setup();
          const token = newToken();
          const orphan = options.newRunId();
          await options.stageOrphan?.(orphan, token);

          const cancelled = await refusal(
            create(events, orphan, {
              eventType: 'run_cancelled',
              specVersion: SPEC,
            } as AnyEventRequest)
          );
          // Fenced as admitted-but-uncreated, or not found where the World
          // records no decision for it; either way it can never be created.
          expect(
            (cancelled as { code?: unknown }).code ===
              START_HOOK_CANDIDATE_CANCELLED_CODE ||
              errorNamed(cancelled, 'WorkflowRunNotFoundError')
          ).toBe(true);
          await refusal(create(events, orphan, runStarted({ token })));
          await refusal(create(events, orphan, runCreated({ token })));
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
