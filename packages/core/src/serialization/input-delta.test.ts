import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StepInvocationQueueItem } from '../global.js';
import {
  dehydrateStepArguments,
  dehydrateStepInputWithDelta,
  hydrateStepArguments,
} from '../serialization.js';
import {
  applyValueOp,
  diffValue,
  isPlainData,
  takeFullPayload,
} from './input-delta.js';

function rnd(seed: number, len: number): string {
  let x = (seed * 2654435761) >>> 0;
  let out = '';
  while (out.length < len) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += x.toString(36);
  }
  return out.slice(0, len);
}
function msg(i: number) {
  return { role: i % 2 ? 'assistant' : 'user', content: rnd(i + 1, 2000) };
}

describe('input delta value ops', () => {
  const cases: [unknown, unknown][] = [
    [{ a: 1 }, { a: 1 }],
    [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ],
    [{ a: 1, b: 2 }, { a: 1 }],
    [{ a: 1 }, { a: 1, b: undefined }],
    [{ a: undefined }, {}],
    [
      [1, 2, 3],
      [1, 2, 3, 4],
    ],
    [
      [1, 2, 3],
      [1, 2],
    ],
    [
      [1, { x: 1 }],
      [1, { x: 2, y: [1] }],
    ],
    [{ h: [msg(0)] }, { h: [msg(0), msg(1), msg(2)] }],
    [null, { a: 1 }],
    [
      { n: Number.NaN, z: -0 },
      { n: Number.NaN, z: 0 },
    ],
    [[1], { 0: 1 }],
    [{ t: 'a'.repeat(300) }, { t: 'a'.repeat(300) + 'tail' }],
    [{ t: 'a'.repeat(300) }, { t: 'b' + 'a'.repeat(300) }],
    ['short', 'shorter'],
  ];
  it.each(cases)('round-trips %j -> %j', (base, next) => {
    const op = diffValue(base, next);
    const out = applyValueOp(base, op);
    expect(
      Object.is(out, next) || JSON.stringify(out) === JSON.stringify(next)
    ).toBe(true);
    expect(out).toStrictEqual(next);
    if (out && typeof out === 'object' && !Array.isArray(out))
      expect(Object.keys(out)).toEqual(Object.keys(next as object));
  });

  it('skips identical shared subtrees without descending', () => {
    const shared = Array.from({ length: 50 }, (_, i) => msg(i));
    const base = { history: shared, ctx: { big: 'x'.repeat(10_000) } };
    const next = { history: [...shared, msg(50)], ctx: base.ctx };
    const op = diffValue(base, next);
    expect(op).toEqual({
      k: 'o',
      p: [['history', { k: 'a', n: 51, s: [[50, msg(50)]] }]],
    });
  });

  it('encodes a growing string as an append', () => {
    const base = 'x'.repeat(1000);
    expect(diffValue({ t: base }, { t: base + 'yz' })).toEqual({
      k: 'o',
      p: [['t', { k: 's', n: 1000, v: 'yz' }]],
    });
  });

  it('does not mutate the base', () => {
    const base = { a: [1, 2], b: { c: 1 } };
    const frozen = JSON.stringify(base);
    applyValueOp(base, diffValue(base, { a: [1, 2, 3], b: { c: 2 } }));
    expect(JSON.stringify(base)).toBe(frozen);
  });

  it('classifies supported data', () => {
    expect(isPlainData({ a: [1, 'x', null, undefined, true, 1n] })).toBe(true);
    expect(isPlainData({ d: new Date() })).toBe(false);
    expect(isPlainData([1, , 3])).toBe(false);
    expect(isPlainData({ m: new Map() })).toBe(false);
    class X {}
    expect(isPlainData({ x: new X() })).toBe(false);
    expect(isPlainData(Object.create(null))).toBe(true);
  });
});

describe('input delta writer and recovery', () => {
  const prev = process.env.WORKFLOW_INPUT_DELTA;
  beforeEach(() => {
    process.env.WORKFLOW_INPUT_DELTA = '1';
  });
  afterEach(() => {
    process.env.WORKFLOW_INPUT_DELTA = prev;
  });

  function item(
    id: string,
    history: unknown[],
    ordinal: number,
    base?: StepInvocationQueueItem
  ): StepInvocationQueueItem {
    return {
      type: 'step',
      correlationId: id,
      stepName: 'turnStep',
      args: [{ history, context: { big: rnd(999, 20_000) } }] as any,
      callOrdinal: ordinal,
      deltaBase: base,
      hasCreatedEvent: true,
    };
  }
  const full = (v: unknown) =>
    dehydrateStepArguments(
      v,
      'wrun_1',
      undefined,
      globalThis,
      false,
      true
    ) as any;

  it('writes deltas, hydrates from memory, and recovers cold through the chain', async () => {
    const h0 = Array.from({ length: 30 }, (_, i) => msg(i));
    const items: StepInvocationQueueItem[] = [];
    const stored = new Map<string, unknown>();
    let history = h0;
    for (let n = 0; n < 4; n++) {
      history = [...history, msg(100 + n)];
      const it2 = item(`step_${n}`, history, n, items[n - 1]);
      items.push(it2);
      const out = await dehydrateStepInputWithDelta(
        it2,
        undefined,
        globalThis,
        full
      );
      stored.set(it2.correlationId, out.input);
      expect(out.inputDelta?.kind).toBe(n === 0 ? 'snapshot' : 'delta');
      if (n > 0) {
        expect((out.input as Uint8Array).byteLength).toBeLessThan(2_000);
      }
    }
    const world = {
      steps: {
        get: async (_runId: string, stepId: string) => ({
          input: stored.get(stepId),
        }),
      },
    } as any;
    const expected = {
      args: items[3].args,
      closureVars: undefined,
      thisVal: undefined,
    };

    const stats = { memoryHits: 0, recoveryFetches: 0, patchesApplied: 0 };
    const warm = await hydrateStepArguments(
      stored.get('step_3'),
      'wrun_1',
      undefined,
      [],
      globalThis,
      {},
      undefined,
      undefined,
      undefined,
      { world, stats }
    );
    expect(warm).toStrictEqual(expected);
    expect(stats.memoryHits).toBe(1);

    // Simulate a cold process: drop the in-memory full payloads.
    for (const it2 of items) {
      const map = (globalThis as any)[
        Symbol.for('__workflowInputDeltaFullPayloads/v1')
      ] as Map<string, Uint8Array>;
      map.clear();
      void it2;
    }
    const coldStats = { memoryHits: 0, recoveryFetches: 0, patchesApplied: 0 };
    const cold = await hydrateStepArguments(
      stored.get('step_3'),
      'wrun_1',
      undefined,
      [],
      globalThis,
      {},
      undefined,
      undefined,
      undefined,
      { world, stats: coldStats }
    );
    expect(cold).toStrictEqual(expected);
    expect(coldStats.recoveryFetches).toBe(3);
    expect(coldStats.patchesApplied).toBe(3);
  });

  it('refuses a recovered input whose digest does not match', async () => {
    const h = [msg(0)];
    const a = item('step_a', h, 0);
    const b = item('step_b', [...h, msg(1)], 1, a);
    const sa = await dehydrateStepArguments(
      { args: a.args, closureVars: undefined, thisVal: undefined },
      'r',
      undefined,
      globalThis,
      false,
      true
    );
    const sb = await dehydrateStepInputWithDelta(
      b,
      undefined,
      globalThis,
      full
    );
    const map = (globalThis as any)[
      Symbol.for('__workflowInputDeltaFullPayloads/v1')
    ] as Map<string, Uint8Array>;
    map.clear();
    // Base on the "server" diverged from what replay diffed against.
    const tampered = await dehydrateStepArguments(
      {
        args: [{ history: [msg(9)], context: { big: rnd(999, 20_000) } }],
        closureVars: undefined,
        thisVal: undefined,
      },
      'r',
      undefined,
      globalThis,
      false,
      true
    );
    void sa;
    const world = { steps: { get: async () => ({ input: tampered }) } } as any;
    await expect(
      hydrateStepArguments(
        sb.input,
        'r',
        undefined,
        [],
        globalThis,
        {},
        undefined,
        undefined,
        undefined,
        { world }
      )
    ).rejects.toThrow(/digest mismatch/);
  });

  it('falls back to a full input for unsupported values and uncommitted bases', async () => {
    const a = item('step_a', [msg(0)], 0);
    const b = item('step_b', [msg(0), msg(1)], 1, a);
    a.hasCreatedEvent = false;
    expect(
      (await dehydrateStepInputWithDelta(b, undefined, globalThis, full))
        .inputDelta?.reason
    ).toBe('base_uncommitted');
    a.hasCreatedEvent = true;
    (b.args[0] as any).when = new Date(0);
    expect(
      (await dehydrateStepInputWithDelta(b, undefined, globalThis, full))
        .inputDelta?.reason
    ).toBe('unsupported_value');
  });

  it('is a no-op when the flag is off', async () => {
    process.env.WORKFLOW_INPUT_DELTA = '0';
    const a = item('step_a', [msg(0)], 0);
    const b = item('step_b', [msg(0), msg(1)], 1, a);
    const out = await dehydrateStepInputWithDelta(
      b,
      undefined,
      globalThis,
      full
    );
    expect(out.inputDelta?.kind).toBe('snapshot');
    expect(takeFullPayload('x')).toBeUndefined();
  });
});
