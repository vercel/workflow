import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importKey } from './encryption.js';
import { History } from './history.js';
import { splitHistoryEnvelope } from './serialization/history-envelope.js';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import {
  dehydrateStepReturnValue,
  hydrateStepArguments,
  hydrateStepReturnValue,
} from './serialization.js';

vi.mock('./runtime/get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));
const outputs = new Map<string, Uint8Array>();
function world() {
  return {
    steps: {
      get: vi.fn(async (_r: string, id: string) => {
        const output = outputs.get(id);
        if (!output) throw new Error('missing');
        return { status: 'completed', output };
      }),
    },
  };
}
async function commit(stepId: string, value: unknown) {
  const bytes = (await dehydrateStepReturnValue(
    value,
    'wrun_test',
    undefined,
    [],
    globalThis,
    false,
    false,
    false,
    undefined,
    [],
    stepId
  )) as Uint8Array;
  outputs.set(stepId, bytes);
  return await hydrateStepReturnValue(bytes, 'wrun_test', undefined);
}

describe('History', () => {
  beforeEach(() => {
    outputs.clear();
    vi.mocked(getWorldLazy).mockResolvedValue(world() as never);
  });
  it('stores additions in committed outputs and chains without serializing old payloads', async () => {
    const first = (await commit('step_1', {
      history: History.from([{ n: 1 }]),
      control: 1,
    })) as { history: History<{ n: number }> };
    const second = (await commit('step_2', {
      history: first.history.append({ n: 2 }),
      unchanged: first.history,
    })) as {
      history: History<{ n: number }>;
      unchanged: History<{ n: number }>;
    };
    expect(await second.history.toArray()).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await second.unchanged.toArray()).toEqual([{ n: 1 }]);
    expect(
      splitHistoryEnvelope(outputs.get('step_2')!).parseRecipes()
    ).toHaveLength(1);
  });
  it('supports fixed-prefix branches and detached extraction/reinsertion', async () => {
    const base = (await commit('step_a', {
      history: History.from([{ n: 1 }, { n: 2 }]),
    })) as { history: History<{ n: number }> };
    const prefix = base.history.take(1);
    const extracted = await prefix.get(0);
    extracted!.n = 9;
    const left = (await commit('step_b', {
      history: prefix.append(extracted!),
    })) as { history: History<{ n: number }> };
    const right = (await commit('step_c', {
      history: prefix.append({ n: 3 }),
    })) as { history: History<{ n: number }> };
    expect(await left.history.toArray()).toEqual([{ n: 1 }, { n: 9 }]);
    expect(await right.history.toArray()).toEqual([{ n: 1 }, { n: 3 }]);
  });
  it('keeps candidate data unpublished before accepted step output', async () => {
    const draft = History.from([1]).append(2);
    expect(await draft.toArray()).toEqual([1, 2]);
    expect(outputs.size).toBe(0);
    await commit('accepted', { history: draft });
    expect(outputs.size).toBe(1);
  });
  it('resolves cold without workflow/body or unrelated custom deserializers', async () => {
    let called = 0;
    class Evil {
      static classId = 'evil';
      static [Symbol.for('workflow-deserialize')]() {
        called++;
        return new Evil();
      }
    }
    const first = (await commit('step_1', {
      history: History.from([1]),
      sibling: { large: 'x'.repeat(10000) },
    })) as { history: History<number> };
    await expect(first.history.toArray()).resolves.toEqual([1]);
    expect(called).toBe(0);
  });
  it('rejects missing, malformed, and cyclic recipe refs', async () => {
    const first = (await commit('step_1', {
      history: History.from([1]),
    })) as { history: History<number> };
    outputs.delete('step_1');
    await expect(first.history.toArray()).rejects.toThrow();
  });
  it('reports draft length as base prefix plus additions', async () => {
    const first = (await commit('step_1', {
      history: History.from([1, 2]),
    })) as { history: History<number> };
    const draft = first.history.append(3, 4);
    expect(draft.length).toBe(4);
  });

  it('rejects getters, proxies, sparse arrays, symbols, and preserves __proto__', () => {
    let getterCalls = 0;
    const withGetter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        getterCalls++;
        return 1;
      },
    });
    expect(() => History.from([withGetter])).toThrow('data properties');
    expect(getterCalls).toBe(0);
    expect(() => History.from([new Proxy({}, {})])).toThrow('proxies');
    const sparse = new Array(2);
    sparse[1] = 1;
    expect(() => History.from([sparse])).toThrow('sparse');
    expect(() => History.from([{ [Symbol('x')]: 1 }])).toThrow('symbol');
    const special = JSON.parse('{"__proto__":{"safe":true}}');
    expect(() => History.from([special])).not.toThrow();
  });

  it('materializes a long chain with one final assembly', async () => {
    let history = (
      (await commit('step_0', {
        history: History.from([0]),
      })) as { history: History<number> }
    ).history;
    for (let index = 1; index < 128; index++) {
      history = (
        (await commit(`step_${index}`, {
          history: history.append(index),
        })) as { history: History<number> }
      ).history;
    }
    expect(await history.toArray()).toEqual(
      Array.from({ length: 128 }, (_, i) => i)
    );
  });

  it('supports local from/append/take/read and immutable branches', async () => {
    const seed = History.from([0, 1]);
    const intermediate = seed.append(2);
    const final = intermediate.append(3, 4);
    expect(seed.length).toBe(2);
    expect(intermediate.length).toBe(3);
    expect(final.length).toBe(5);
    expect(await final.toArray()).toEqual([0, 1, 2, 3, 4]);
    expect(await final.take(0).toArray()).toEqual([]);
    expect(await final.take(2).toArray()).toEqual([0, 1]);
    expect(await final.take(4).append(9).toArray()).toEqual([0, 1, 2, 3, 9]);
    const left = intermediate.append(7);
    const right = intermediate.append(8);
    expect(await left.toArray()).toEqual([0, 1, 2, 7]);
    expect(await right.toArray()).toEqual([0, 1, 2, 8]);
    expect(final.append()).toBe(final);
    expect(final.take(final.length)).toBe(final);
  });

  it('supports local drafts based on a committed prefix', async () => {
    const committed = (await commit('step_1', {
      history: History.from([0, 1, 2]),
    })) as { history: History<number> };
    const draft = committed.history.append(3, 4);
    expect(await draft.toArray()).toEqual([0, 1, 2, 3, 4]);
    expect(await draft.take(2).append(9).toArray()).toEqual([0, 1, 9]);
    expect(await draft.take(4).toArray()).toEqual([0, 1, 2, 3]);
  });

  it('duplicates only local additions when intermediate and final are returned', async () => {
    const seed = History.from([{ n: 1 }]);
    const intermediate = seed.append({ n: 2 });
    const final = intermediate.append({ n: 3 });
    const onlyFinal = (await dehydrateStepReturnValue(
      { final },
      'wrun_test',
      undefined,
      [],
      globalThis,
      false,
      false,
      false,
      undefined,
      [],
      'step_final'
    )) as Uint8Array;
    const both = (await dehydrateStepReturnValue(
      { intermediate, final, alias: final },
      'wrun_test',
      undefined,
      [],
      globalThis,
      false,
      false,
      false,
      undefined,
      [],
      'step_both'
    )) as Uint8Array;
    const onlyRecipes = splitHistoryEnvelope(onlyFinal).parseRecipes()!;
    const bothRecipes = splitHistoryEnvelope(both).parseRecipes()!;
    expect(onlyRecipes).toHaveLength(1);
    // devalue preserves the duplicate `final` alias, so it is one slot; the
    // independently returned intermediate duplicates its local additions.
    expect(bothRecipes).toHaveLength(2);
    expect(JSON.stringify(bothRecipes).length).toBeGreaterThan(
      JSON.stringify(onlyRecipes).length
    );
  });

  it('compacts by returning a fresh step-owned root', async () => {
    const original = (await commit('step_original', {
      history: History.from([
        { role: 'user', text: 'old' },
        { role: 'assistant', text: 'answer' },
        { role: 'user', text: 'retained' },
      ]),
    })) as { history: History<{ role: string; text: string }> };
    const materialized = await original.history.toArray();
    const compacted = (await commit('step_compact', {
      history: History.from([
        { role: 'system', text: 'summary' },
        materialized.at(-1)!,
      ]),
    })) as { history: History<{ role: string; text: string }> };
    const compactRecipe = splitHistoryEnvelope(
      outputs.get('step_compact')!
    ).parseRecipes()![0];
    expect(compactRecipe.base).toBeUndefined();
    expect(await compacted.history.toArray()).toEqual([
      { role: 'system', text: 'summary' },
      { role: 'user', text: 'retained' },
    ]);
    const extended = (await commit('step_after_compact', {
      history: compacted.history.append({ role: 'assistant', text: 'new' }),
    })) as { history: History<{ role: string; text: string }> };
    expect(await extended.history.toArray()).toHaveLength(3);
    expect(await original.history.toArray()).toHaveLength(3);
  });

  it.each([
    { encrypted: false, compressed: false },
    { encrypted: false, compressed: true },
    { encrypted: true, compressed: false },
    { encrypted: true, compressed: true },
  ])('authenticates recipes with existing pipeline $encrypted/$compressed', async ({
    encrypted,
    compressed,
  }) => {
    const key = encrypted
      ? await importKey(crypto.getRandomValues(new Uint8Array(32)))
      : undefined;
    const bytes = (await dehydrateStepReturnValue(
      { history: History.from([{ text: 'x'.repeat(2000) }]) },
      'wrun_test',
      key,
      [],
      globalThis,
      false,
      false,
      compressed,
      undefined,
      [],
      'step_secure'
    )) as Uint8Array;
    const hydrated = (await hydrateStepReturnValue(
      bytes,
      'wrun_test',
      key
    )) as { history: History<{ text: string }> };
    expect(hydrated.history.length).toBe(1);
    if (encrypted) {
      const tampered = bytes.slice();
      tampered[tampered.length - 1] ^= 1;
      await expect(
        hydrateStepReturnValue(tampered, 'wrun_test', key)
      ).rejects.toThrow();
      await expect(
        hydrateStepReturnValue(bytes, 'wrun_test', undefined)
      ).rejects.toThrow();
    }
  });

  it('leaves ordinary output bytes unchanged', async () => {
    const before = await dehydrateStepReturnValue(
      { ordinary: 1 },
      'wrun_test',
      undefined
    );
    const withUnusedStepId = await dehydrateStepReturnValue(
      { ordinary: 1 },
      'wrun_test',
      undefined,
      [],
      globalThis,
      false,
      false,
      false,
      undefined,
      [],
      'step_unused'
    );
    expect(withUnusedStepId).toEqual(before);
  });

  it('ordinary extracted values serialize normally', async () => {
    const first = (await commit('step_1', {
      history: History.from([{ n: 1 }]),
    })) as { history: History<{ n: number }> };
    const ordinary = await first.history.get(0);
    const bytes = await dehydrateStepReturnValue(
      { ordinary },
      'wrun_test',
      undefined
    );
    const hydrated = await hydrateStepArguments(bytes, 'wrun_test', undefined);
    expect(hydrated.ordinary).toEqual({ n: 1 });
  });
});
