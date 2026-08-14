/**
 * Offline replay of the ACTUAL corrupted production log from
 * `wrun_41KZYJ92TP0GYBNDKW3FJBWQ3Y` (step-storm repro, preview, 2026-08-13,
 * CORRUPTED_EVENT_LOG after 4 deterministic divergences at slot 630).
 *
 * The fixture (/tmp/rr_fixture.json, built from ClickHouse
 * workflow_observability_staging) preserves every committed event's slot
 * order, type, entity kind, step name, and the ULID *rank* of its correlation
 * id. Ranks are remapped onto this harness's deterministic ULID sequence, so
 * the workflow body below (a faithful port of `stepStormReproWorkflow`)
 * mints ids that line up rank-for-rank with the committed ones.
 *
 * Two questions, one replay each:
 *
 *  1. Full log: does a faithful replay diverge at the slot-630 equivalent
 *     with "belongs to finalizeStep, but the current step consumer is
 *     releaseStep"? (Validates the canonical-order derivation and that the
 *     committed bindings really are mutually inconsistent.)
 *
 *  2. Writer B's prefix (slots 1..610): what does a faithful replay of
 *     exactly what 45cb4c904d25 loaded (`eventCount: 610`) draw for the
 *     pending creates? If it binds rank 198 (WZ) to finalizeStep, B was
 *     prefix-determined; if not, B's committed binding deviated from its own
 *     prefix and the bug is in the live loop, not in replay determinism.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

const SEED = 'test';
const FIXED_TS = 1753481739458;

/** The same deterministic ULID sequence the replay context will draw from. */
function generateUlidSequence(count: number): string[] {
  const context = createContext({ seed: SEED, fixedTimestamp: FIXED_TS });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const at = context.globalThis.Date.now();
  return Array.from({ length: count }, () => ulid(at));
}

function setupWorkflowContext(
  events: Event[],
  replayPayloadCache: ReplayPayloadCache = new ReplayPayloadCache(undefined)
): WorkflowOrchestratorContext {
  const context = createContext({ seed: SEED, fixedTimestamp: FIXED_TS });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const promiseQueueHolder = { current: Promise.resolve() };
  const ctxRef: { current?: WorkflowOrchestratorContext } = {};
  const ctx: WorkflowOrchestratorContext = {
    suspensionGeneration: 0,
    runId: 'wrun_test',
    encryptionKey: undefined,
    replayPayloadCache,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      isDeliveryIdle: () => true,
      onUnconsumedEvent: (event) => {
        ctxRef.current?.onWorkflowError(
          new WorkflowRuntimeError(
            `Unconsumed event: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}.`
          )
        );
      },
      getPromiseQueue: () => promiseQueueHolder.current,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: () => {},
    get promiseQueue() {
      return promiseQueueHolder.current;
    },
    set promiseQueue(value: Promise<void>) {
      promiseQueueHolder.current = value;
    },
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
  };
  ctxRef.current = ctx;
  return ctx;
}

interface FixtureEvent {
  s: number; // slot
  t: string; // eventType
  k: string; // step | wait | hook | run (attr_set)
  r: number; // ULID rank of the correlation id, -1 for run-scoped
  n: string; // step name (short)
}

const WATCHDOG = Symbol.for('storm-log-replay:watchdog');
const TOKEN = 'storm-log-replay-token';

async function buildEvents(
  fixture: FixtureEvent[],
  ulids: string[]
): Promise<Event[]> {
  const ops: Promise<any>[] = [];
  const stepResult = await dehydrateStepReturnValue(
    { ok: true },
    'wrun_test',
    undefined,
    ops
  );
  const hookPayload = await dehydrateStepReturnValue(
    { round: 0, index: 0, sentAt: 1 },
    'wrun_test',
    undefined,
    ops
  );
  const events: Event[] = [];
  for (const f of fixture) {
    const eventId = `evnt_${String(f.s).padStart(26, '0')}`;
    const createdAt = new Date(FIXED_TS + f.s);
    if (f.t === 'attr_set') {
      events.push({
        eventId,
        runId: 'wrun_test',
        eventType: 'attr_set',
        correlationId: 'wrun_test',
        eventData: { attributes: { settle: 'x' } },
        createdAt,
      } as unknown as Event);
      continue;
    }
    const correlationId = `${f.k}_${ulids[f.r]}`;
    let eventData: Record<string, unknown>;
    switch (f.t) {
      case 'hook_created':
        eventData = { token: `${TOKEN}:poke`, isWebhook: false };
        break;
      case 'hook_received':
        eventData = { payload: hookPayload };
        break;
      case 'wait_created':
      case 'wait_completed':
        // Same value on created/completed per entity is all the consumer
        // requires (it re-reads resumeAt off wait_created).
        eventData = { resumeAt: new Date(FIXED_TS + 1_000_000 + f.r) };
        break;
      case 'step_created':
      case 'step_started':
        eventData = { stepName: f.n };
        break;
      case 'step_completed':
        eventData = { stepName: f.n, result: stepResult };
        break;
      default:
        throw new Error(`unhandled event type ${f.t}`);
    }
    events.push({
      eventId,
      runId: 'wrun_test',
      eventType: f.t,
      correlationId,
      eventData,
      createdAt,
    } as unknown as Event);
  }
  return events;
}

function workflowBody(ctx: WorkflowOrchestratorContext) {
  const useStep = createUseStep(ctx);
  const sleep = createSleep(ctx);
  const createHook = createCreateHook(ctx);
  const settleStep = useStep('settleStep');
  const recoverStep = useStep('recoverStep');
  const finalizeStep = useStep('finalizeStep');
  const releaseStep = useStep('releaseStep');
  const reconcileStep = useStep('reconcileStep');

  const cfg = {
    rounds: 6,
    width: 8,
    watchdogMs: 2500,
    betweenRoundSleepMs: 1000,
    reconcileBase: 2,
  };

  return async () => {
    const pokeHook = createHook({ token: `${TOKEN}:poke` });
    try {
      for (let round = 0; round < cfg.rounds; round += 1) {
        const branches = await Promise.all(
          Array.from({ length: cfg.width }, (_, index) =>
            (async () => {
              try {
                const winner = await Promise.race([
                  settleStep({ round, index }),
                  sleep(cfg.watchdogMs).then(() => WATCHDOG),
                ]);
                if (winner === WATCHDOG) {
                  await recoverStep({ round, index });
                  await finalizeStep({ round, index, winner: 'watchdog' });
                  return { winner: 'watchdog' as const };
                }
                await finalizeStep({ round, index, winner: 'settled' });
                return { winner: 'settled' as const };
              } finally {
                await releaseStep({ round, index });
              }
            })()
          )
        );
        const stragglers = branches.filter(
          (b) => b.winner === 'watchdog'
        ).length;
        await Promise.all(
          Array.from({ length: cfg.reconcileBase + stragglers }, (_, index) =>
            reconcileStep({ round, index, stragglers })
          )
        );
        if (cfg.betweenRoundSleepMs > 0) {
          await sleep(cfg.betweenRoundSleepMs);
        }
      }
    } finally {
      pokeHook.dispose();
    }
  };
}

async function replay(events: Event[]): Promise<{
  error?: any;
  ctx: WorkflowOrchestratorContext;
}> {
  const ctx = setupWorkflowContext(events);
  const discontinuation = withResolvers<void>();
  ctx.onWorkflowError = discontinuation.reject;
  let error: any;
  try {
    await Promise.race([workflowBody(ctx)(), discontinuation.promise]);
  } catch (err) {
    error = err;
  }
  return { error, ctx };
}

describe('replaying the corrupted production storm log', () => {
  const fixture: FixtureEvent[] = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '__fixtures__',
        'wrun-41KZYJ92TP-storm-log.json'
      ),
      'utf8'
    )
  );
  const maxRank = Math.max(...fixture.map((f) => f.r));
  const ulids = generateUlidSequence(maxRank + 8);

  /** Pending-step bindings by ULID rank after replaying `len` slots. */
  async function bindingsAtLength(
    len: number
  ): Promise<{ error: any; byRank: Map<number, string> }> {
    const prefix = fixture.filter((f) => f.s <= len);
    const events = await buildEvents(prefix, ulids);
    const { error, ctx } = await replay(events);
    const byRank = new Map<number, string>();
    for (const item of ctx.invocationsQueue.values()) {
      if (item.type !== 'step') continue;
      const rank = ulids.indexOf(item.correlationId.split('_', 2)[1]);
      byRank.set(rank, item.stepName);
    }
    return { error, byRank };
  }

  it('full log: still diverges — the committed log holds bindings from two incompatible trajectories', async () => {
    // The production writers created the SAME logical finalize step under two
    // correlation ids (ranks 198 and 199, slots 630 and 631) from
    // different-length prefixes under the pre-fix scheduler. No single
    // deterministic trajectory can satisfy both creates, so a faithful replay
    // of the full log must reject one of them. What the fix guarantees is not
    // that this log becomes readable, but that new logs cannot acquire this
    // shape: writers holding different-length prefixes now draw identical
    // bindings (the tests below).
    const events = await buildEvents(fixture, ulids);
    const { error } = await replay(events);
    expect(error).toBeDefined();
    expect(WorkflowSuspension.is(error)).toBe(false);
    expect(String(error?.message)).toContain('Replay divergence');
  });

  it("writer B's exact 610-event prefix reproduces writer B's committed binding", async () => {
    // Rank 198 is `step_…QMWZ`, which the writer holding this exact prefix
    // (eventCount: 610 in its runtime logs) committed as finalizeStep at slot
    // 630. A faithful replay of its prefix must derive the same pending
    // create, or the writer was never prefix-determined and replay itself is
    // nondeterministic.
    const { error, byRank } = await bindingsAtLength(610);
    expect(WorkflowSuspension.is(error)).toBe(true);
    expect(byRank.get(197)).toContain('releaseStep');
    expect(byRank.get(198)).toContain('finalizeStep');
  });

  it('draw bindings are stable under log extension', async () => {
    // THE regression assertion for the ordered safety-net dispenser
    // (ensureBarrierSafetyNet): pending-step bindings derived from a prefix
    // must never change when the same replay code is handed MORE of the same
    // log. Before the fix, extending this log from 611 to 612 slots moved
    // rank 198 from finalizeStep to releaseStep — two honest replayers with
    // different-length snapshots then committed conflicting creates, which is
    // the residual slot-mode CORRUPTED_EVENT_LOG mechanism
    // (wrun_41KZYJ92TP0GYBNDKW3FJBWQ3Y).
    //
    // 630 is the longest clean prefix: 631 holds the second of the two
    // incompatible committed creates, past which replay rightly diverges.
    const lengths = [610, 611, 612, 619, 630];
    const results = new Map<number, Map<number, string>>();
    for (const len of lengths) {
      const { error, byRank } = await bindingsAtLength(len);
      expect(WorkflowSuspension.is(error)).toBe(true);
      results.set(len, byRank);
    }
    for (let i = 1; i < lengths.length; i++) {
      const shorter = results.get(lengths[i - 1])!;
      const longer = results.get(lengths[i])!;
      for (const [rank, name] of shorter) {
        const extended = longer.get(rank);
        // A rank absent from the longer replay was consumed by its (matching)
        // created event arriving in the extension — only disagreement fails.
        if (extended !== undefined) {
          expect(
            `${lengths[i]}:r${rank}=${extended}`,
            `rank ${rank} rebound between len ${lengths[i - 1]} and ${lengths[i]}`
          ).toBe(`${lengths[i]}:r${rank}=${name}`);
        }
      }
    }
  });
});
