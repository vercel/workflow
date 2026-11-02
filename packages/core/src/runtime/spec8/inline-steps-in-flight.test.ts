import { describe, expect, it } from 'vitest';
import {
  type InlineSettlementRound,
  InlineStepsInFlight,
} from './inline-steps-in-flight.js';

type Result = { type: 'completed' | 'retry' };

const isClean = (outcome: PromiseSettledResult<Result>) =>
  outcome.status === 'fulfilled' && outcome.value.type === 'completed';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function trackStep(
  steps: InlineStepsInFlight<{ correlationId: string }, Result>,
  id: string
) {
  const execution = deferred<Result>();
  const start = deferred<void>();
  steps.track({ correlationId: id }, execution.promise, start.promise);
  return { execution, start };
}

describe('InlineStepsInFlight', () => {
  it('returns early with the clean settlement and keeps the running step', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    b.start.resolve();
    a.execution.resolve({ type: 'completed' });

    const round = await steps.settle(true, isClean);
    expect(round.early).toBe(true);
    expect(round.settled.map((s) => s.step.correlationId)).toEqual(['a']);
    expect([...steps.ids]).toEqual(['b']);

    b.execution.resolve({ type: 'completed' });
    const last = await steps.settle(true, isClean);
    expect(last.early).toBe(false);
    expect(last.settled.map((s) => s.step.correlationId)).toEqual(['b']);
    expect(steps.size).toBe(0);
  });

  it('waits for a running step whose claim has not settled', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    a.execution.resolve({ type: 'completed' });

    let returned = false;
    const round = steps.settle(true, isClean).then((r) => {
      returned = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(returned).toBe(false);

    b.start.resolve();
    expect((await round).early).toBe(true);
  });

  it('waits for the whole batch after an outcome that needs batch handling', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    b.start.resolve();
    a.execution.resolve({ type: 'retry' });
    setTimeout(() => b.execution.resolve({ type: 'completed' }), 5);

    const round = await steps.settle(true, isClean);
    expect(round.early).toBe(false);
    expect(round.settled.map((s) => s.step.correlationId)).toEqual(['a', 'b']);
  });

  it('treats a rejection as needing batch handling', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    b.start.resolve();
    a.execution.reject(new Error('boom'));
    setTimeout(() => b.execution.resolve({ type: 'completed' }), 5);

    const round = await steps.settle(true, isClean);
    expect(round.early).toBe(false);
    expect(round.settled[0].outcome.status).toBe('rejected');
  });

  it('never returns early when disabled', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    b.start.resolve();
    a.execution.resolve({ type: 'completed' });
    setTimeout(() => b.execution.resolve({ type: 'completed' }), 5);

    const round = await steps.settle(false, isClean);
    expect(round.early).toBe(false);
    expect(round.settled).toHaveLength(2);
  });
});

type Outcome = 'clean' | 'dirty' | 'reject';
type StepEvent = { step: number; kind: 'claim' | 'settle' };
type Round = InlineSettlementRound<{ correlationId: string }, Outcome>;

const STEP_COUNT = 3;
const OUTCOMES: Outcome[] = ['clean', 'dirty', 'reject'];

/** Every order of `sequences` that keeps each sequence's own order. */
function* interleavings(sequences: StepEvent[][]): Generator<StepEvent[]> {
  const next = sequences.map(() => 0);
  const order: StepEvent[] = [];
  const total = sequences.reduce((n, s) => n + s.length, 0);
  function* extend(): Generator<StepEvent[]> {
    if (order.length === total) {
      yield [...order];
      return;
    }
    for (let i = 0; i < sequences.length; i++) {
      if (next[i] === sequences[i].length) continue;
      order.push(sequences[i][next[i]++]);
      yield* extend();
      next[i]--;
      order.pop();
    }
  }
  yield* extend();
}

/** Every outcome per step, and every event order with or without claims. */
function* scenarios(): Generator<{ outcome: Outcome[]; order: StepEvent[] }> {
  for (let o = 0; o < OUTCOMES.length ** STEP_COUNT; o++) {
    const outcome = Array.from(
      { length: STEP_COUNT },
      (_, i) => OUTCOMES[Math.floor(o / OUTCOMES.length ** i) % OUTCOMES.length]
    );
    for (let c = 0; c < 2 ** STEP_COUNT; c++) {
      const sequences = Array.from({ length: STEP_COUNT }, (_, i) => [
        ...((c >> i) & 1 ? [{ step: i, kind: 'claim' as const }] : []),
        { step: i, kind: 'settle' as const },
      ]);
      for (const order of interleavings(sequences)) yield { outcome, order };
    }
  }
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** The invariants of one round, given what has happened so far. */
function checkRound(
  round: Round,
  steps: InlineStepsInFlight<{ correlationId: string }, Outcome>,
  claimed: Set<number>,
  settled: Set<number>
) {
  expect(round.settled.length).toBeGreaterThan(0);
  for (const s of round.settled) {
    expect(settled.has(Number(s.step.correlationId))).toBe(true);
  }
  if (!round.early) {
    expect(steps.size).toBe(0);
    return;
  }
  for (const s of round.settled) {
    expect(s.outcome).toEqual({ status: 'fulfilled', value: 'clean' });
  }
  expect(steps.size).toBeGreaterThan(0);
  for (const id of steps.ids) {
    // Every settled step was taken, and every step still running has a
    // settled claim.
    expect(settled.has(Number(id))).toBe(false);
    expect(claimed.has(Number(id))).toBe(true);
  }
}

/**
 * Drive one scenario the way the replay loop does: call `settle(true)` until
 * nothing is tracked. Returns how many rounds advanced early.
 */
async function runScenario(outcome: Outcome[], order: StepEvent[]) {
  const steps = new InlineStepsInFlight<{ correlationId: string }, Outcome>();
  const handles = outcome.map((_, i) => {
    const execution = deferred<Outcome>();
    const start = deferred<void>();
    steps.track({ correlationId: `${i}` }, execution.promise, start.promise);
    return { execution, start };
  });
  const claimed = new Set<number>();
  const settled = new Set<number>();
  const taken: string[] = [];
  let earlyRounds = 0;
  let round: Round | undefined;
  let open = false;
  const startRound = () => {
    open = true;
    void steps
      .settle(true, (r) => r.status === 'fulfilled' && r.value === 'clean')
      .then((r) => {
        round = r;
      });
  };
  const takeRound = () => {
    if (!round) return;
    checkRound(round, steps, claimed, settled);
    taken.push(...round.settled.map((s) => s.step.correlationId));
    if (round.early) earlyRounds++;
    round = undefined;
    open = false;
    if (steps.size > 0) startRound();
  };

  startRound();
  await flushMicrotasks();
  expect(round).toBeUndefined();
  for (const event of order) {
    const { execution, start } = handles[event.step];
    if (event.kind === 'claim') {
      claimed.add(event.step);
      start.resolve();
    } else {
      settled.add(event.step);
      const result = outcome[event.step];
      if (result === 'reject') execution.reject(new Error('boom'));
      else execution.resolve(result);
    }
    await flushMicrotasks();
    takeRound();
  }
  expect(open).toBe(false);
  expect(steps.size).toBe(0);
  expect(taken.sort()).toEqual(outcome.map((_, i) => `${i}`));
  return earlyRounds;
}

describe('InlineStepsInFlight over every interleaving', () => {
  // Three steps, each settling clean, needing batch handling, or rejecting,
  // with or without a claim before it settles, in every order of those
  // events.
  it('takes every step once, advances early only when allowed, and drains', async () => {
    let earlyRounds = 0;
    for (const { outcome, order } of scenarios()) {
      earlyRounds += await runScenario(outcome, order);
    }
    expect(earlyRounds).toBeGreaterThan(0);
  });
});
