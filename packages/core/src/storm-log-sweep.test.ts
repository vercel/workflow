/**
 * Companion to storm-log-replay.test.ts: sweep prefix lengths of the real
 * corrupted log and report, per length, which step name ranks 197 (WY) and
 * 198 (WZ) get bound to. Finds the exact log-extension point where a
 * byte-identical shared prefix changes its own draw bindings.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, it } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { isDeliveryIdle, type WorkflowOrchestratorContext } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

const SEED = 'test';
const FIXED_TS = 1753481739458;

function generateUlidSequence(count: number): string[] {
  const context = createContext({ seed: SEED, fixedTimestamp: FIXED_TS });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const at = context.globalThis.Date.now();
  return Array.from({ length: count }, () => ulid(at));
}

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({ seed: SEED, fixedTimestamp: FIXED_TS });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  // Real-session parity: the log-order-draws quiescence fixpoint keys its
  // progress metric on `mintCount`; without it the loop degrades to a single
  // turn and this suite would only exercise a degraded variant.
  let mintCount = 0;
  const promiseQueueHolder = { current: Promise.resolve() };
  const ctxRef: { current?: WorkflowOrchestratorContext } = {};
  const ctx: WorkflowOrchestratorContext = {
    suspensionGeneration: 0,
    runId: 'wrun_test',
    encryptionKey: undefined,
    replayPayloadCache: new ReplayPayloadCache(undefined),
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      isDeliveryIdle: () =>
        ctxRef.current ? isDeliveryIdle(ctxRef.current) : true,
      onUnconsumedEvent: (event) => {
        ctxRef.current?.onWorkflowError(
          new WorkflowRuntimeError(
            `Unconsumed event: ${event.eventType} ${event.correlationId}`
          )
        );
      },
      getPromiseQueue: () => promiseQueueHolder.current,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => {
      mintCount += 1;
      return ulid(workflowStartedAt);
    },
    get mintCount() {
      return mintCount;
    },
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
  s: number;
  t: string;
  k: string;
  r: number;
  n: string;
}

const WATCHDOG = Symbol.for('storm-log-sweep:watchdog');
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

// ~90s of replays; diagnostic tool rather than a regression test. Run with
// STORM_LOG_SWEEP=1 to reproduce the flip-point table in the PR description.
describe.skipIf(!process.env.STORM_LOG_SWEEP)(
  'prefix-length sweep over the corrupted storm log',
  () => {
    it('reports rank 197/198 bindings per prefix length', async () => {
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
      const rankOf = new Map(ulids.map((u, i) => [u, i]));

      const lines: string[] = [];
      for (const len of [
        605, 608, 610, 611, 612, 615, 617, 618, 619, 620, 621, 622, 623, 624,
        625, 630, 635, 640, 645, 650, 655,
      ]) {
        const prefix = fixture.filter((f) => f.s <= len);
        const events = await buildEvents(prefix, ulids);
        const ctx = setupWorkflowContext(events);
        const discontinuation = withResolvers<void>();
        ctx.onWorkflowError = discontinuation.reject;
        let error: any;
        try {
          await Promise.race([workflowBody(ctx)(), discontinuation.promise]);
        } catch (err) {
          error = err;
        }
        const byRank: Record<number, string> = {};
        for (const item of ctx.invocationsQueue.values()) {
          if (item.type !== 'step') continue;
          const r = rankOf.get(item.correlationId.split('_', 2)[1]);
          if (r !== undefined && r >= 196 && r <= 200) {
            byRank[r] = item.stepName;
          }
        }
        lines.push(
          `len=${len} outcome=${error?.constructor?.name ?? 'none'} ` +
            `r196=${byRank[196] ?? '-'} r197=${byRank[197] ?? '-'} r198=${byRank[198] ?? '-'} r199=${byRank[199] ?? '-'} r200=${byRank[200] ?? '-'} ` +
            `${error?.message?.slice(0, 110)?.replace(/\n/g, ' ') ?? ''}`
        );
      }
      // eslint-disable-next-line no-console
      console.log(`\nSWEEP RESULTS\n${lines.join('\n')}`);
    }, 240_000);
  }
);
