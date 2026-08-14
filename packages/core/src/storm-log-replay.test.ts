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

  it('full log: diverges at the slot-630 equivalent (WZ bound to finalizeStep vs releaseStep consumer)', async () => {
    const events = await buildEvents(fixture, ulids);
    const { error } = await replay(events);
    // Committed bindings are mutually inconsistent, so a faithful replay
    // must reject SOME event. Print exactly which one for analysis.
    // eslint-disable-next-line no-console
    console.log(
      'FULL-LOG replay outcome:',
      error?.constructor?.name,
      error?.message?.slice(0, 300)
    );
    expect(error).toBeDefined();
    expect(WorkflowSuspension.is(error)).toBe(false);
  });

  it("writer B's 610-event prefix: report what a faithful replay draws", async () => {
    const prefix = fixture.filter((f) => f.s <= 610);
    const events = await buildEvents(prefix, ulids);
    const { error, ctx } = await replay(events);
    const pending = [...ctx.invocationsQueue.values()]
      .filter((i) => i.type === 'step')
      .map((i) => ({
        correlationId: i.correlationId,
        rank: ulids.indexOf(i.correlationId.split('_', 2)[1]),
        stepName: (i as any).stepName,
        hasCreatedEvent: (i as any).hasCreatedEvent ?? false,
      }));
    // eslint-disable-next-line no-console
    console.log(
      'PREFIX-610 replay outcome:',
      error?.constructor?.name,
      error?.message?.slice(0, 200)
    );
    // eslint-disable-next-line no-console
    console.log('PREFIX-610 pending steps:', JSON.stringify(pending, null, 1));
    // Rank 198 is WZ. Writer B committed step_created WZ = finalizeStep from
    // exactly this prefix. A faithful replay must therefore have a pending
    // finalizeStep create at rank 198 for B's write to be prefix-determined.
    expect(WorkflowSuspension.is(error)).toBe(true);
  });
});
