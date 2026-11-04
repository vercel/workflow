import { runInNewContext } from 'node:vm';
import { parse } from 'devalue';
import { produce } from 'immer';
import { describe, expect, it, vi } from 'vitest';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  dehydrateWorkflowReturnValue,
  hydrateStepArguments,
  hydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../serialization.js';
import { decodeFormatPrefix } from './format.js';
import { getCommonRevivers } from './reducers/common.js';
import {
  bindStateContext,
  isFrozenState,
  STATE_REF_REDUCER,
  StateContext,
  stateContextForData,
  stateSourceId,
} from './state-refs.js';
import * as workflow from './workflow.js';

type Message = { role: string; content: string };
type Session = { history: Message[]; context: Record<string, unknown> };

const write = (value: unknown, stateContext: StateContext) =>
  workflow.serialize(value, { stateContext });
const read = (bytes: Uint8Array, stateContext: StateContext) =>
  workflow.deserialize(bytes, { stateContext }) as any;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const cold = (...payloads: Uint8Array[]) => {
  const context = new StateContext();
  for (const p of payloads)
    context.ingest(
      decodeFormatPrefix(p).payload as Uint8Array,
      getCommonRevivers(globalThis) as Record<string, (v: unknown) => unknown>
    );
  return context;
};

/** One session as a replay sees it: step 1 is given plain values and returns produced ones. */
function session() {
  const body = new StateContext();
  const start: Session = { history: [], context: { trace: { t: 0 } } };
  const given = read(write({ session: start }, body), body).session as Session;
  const s1 = produce(given, (draft) => {
    draft.history.push(
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' }
    );
    (draft.context.trace as { t: number }).t = 1;
  });
  const output1 = write({ session: s1 }, new StateContext());
  return { body, output1 };
}

describe('frozen values stored by reference', () => {
  it('stores frozen accessors as plain values rather than stale references', () => {
    let current = 'before';
    const state = Object.freeze({
      get value() {
        return current;
      },
    });
    const context = new StateContext();
    const first = write({ state }, context);
    current = 'after';
    const second = workflow.serialize(
      { state },
      { stateContext: context, stateInput: true }
    );
    expect(text(second)).not.toContain(STATE_REF_REDUCER);
    expect(read(second, cold(first)).state.value).toBe('after');
  });

  it('stores values in full for the QuickJS VM, and still reads references', () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session;
    const vm = process.env.WORKFLOW_VM;
    process.env.WORKFLOW_VM = 'quickjs';
    try {
      const plain = write({ session: v1 }, body);
      expect(text(plain)).not.toContain('StateRefV1');
      expect(read(plain, new StateContext()).session).toStrictEqual(v1);
      expect(read(output1, new StateContext()).session).toStrictEqual(v1);
    } finally {
      if (vm === undefined) delete process.env.WORKFLOW_VM;
      else process.env.WORKFLOW_VM = vm;
    }
  });

  it('stores the first result whole, later inputs as references and outputs as changes', () => {
    const { body, output1 } = session();
    expect(text(output1)).toContain('"full"');
    const v1 = read(output1, body).session;
    expect(Object.isFrozen(v1.history)).toBe(true);

    const input2 = write({ session: v1 }, body);
    expect(text(input2)).toContain('"ref"');
    expect(input2.byteLength).toBeLessThan(300);

    const given = read(input2, body).session;
    expect(given).toBe(v1);
    const s2 = produce(given as Session, (draft) => {
      draft.history.push(
        { role: 'user', content: 'next' },
        { role: 'assistant', content: 'ok' }
      );
    });
    const output2 = write({ session: s2 }, body);
    expect(text(output2)).toContain('"patch"');
    expect(text(output2)).toContain('"append"');
    expect(text(output2)).not.toContain('hello');
    expect(
      read(output2, body).session.history.map((m: Message) => m.content)
    ).toEqual(['hello', 'hi', 'next', 'ok']);
  });

  it('stores a whole-value replacement (such as clearing a history) so replay rebuilds it', () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session as Session;
    const cleared = produce(v1.history, () => []);
    const output2 = write({ history: cleared }, body);
    expect(text(output2)).toContain('"full"');
    const replay = new StateContext();
    read(output1, replay);
    expect(read(output2, replay).history).toEqual([]);
    expect(read(output2, cold(output1, output2)).history).toEqual([]);
  });

  it('keeps the holes of a sparse array stored in full', () => {
    const body = new StateContext();
    const values = produce([1] as unknown[], (d) => {
      d[2] = 3;
    });
    const back = read(write({ values }, body), new StateContext())
      .values as unknown[];
    expect(back).toHaveLength(3);
    expect(1 in back).toBe(false);
  });

  it('still stores an append to a top-level array as a patch', () => {
    const body = new StateContext();
    const first = produce([] as Message[], (d) => {
      d.push({ role: 'user', content: 'hello' });
    });
    const v1 = read(write({ history: first }, body), body).history as Message[];
    const grown = produce(v1, (d) => {
      d.push({ role: 'user', content: 'next' });
    });
    const out = text(write({ history: grown }, body));
    expect(out).toContain('"patch"');
    expect(out).toContain('"append"');
  });

  it('keeps step inputs the same size as the history grows', () => {
    const { body, output1 } = session();
    let value = read(output1, body).session;
    const sizes: number[] = [];
    for (let turn = 0; turn < 50; turn++) {
      const input = write({ session: value }, body);
      sizes.push(input.byteLength);
      const next = produce(read(input, body).session as Session, (draft) => {
        draft.history.push({
          role: 'user',
          content: `q${turn} ${'x'.repeat(500)}`,
        });
        draft.history.push({
          role: 'assistant',
          content: `a${turn} ${'y'.repeat(500)}`,
        });
      });
      value = read(write({ session: next }, body), body).session;
    }
    expect(value.history).toHaveLength(102);
    expect(Math.max(...sizes)).toBe(Math.min(...sizes));
  });

  it('rebuilds a referenced input in a new invocation from outputs alone, and encodes its output as a change', () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session;
    const input2 = write({ session: v1 }, body);

    const retry = cold(output1);
    const given = read(input2, retry).session;
    expect(given).toStrictEqual(v1);
    const output2 = write(
      {
        session: produce(given as Session, (d) => {
          d.history.push({ role: 'assistant', content: 'cold' });
        }),
      },
      retry
    );
    expect(text(output2)).toContain('"patch"');

    const replayed = read(output2, body).session;
    expect(
      read(write({ session: replayed }, body), cold(output1, output2)).session
    ).toStrictEqual(replayed);
  });

  it('refers to long strings a hook payload already stores, without changing the payload format', () => {
    const { body, output1 } = session();
    const message = 'Weather in Oslo for the next three days, please. '.repeat(
      4
    );
    const hook = write({ message }, new StateContext());
    // A runtime without state-reference support reads the payload as before.
    expect(text(hook)).not.toContain(STATE_REF_REDUCER);
    expect(parse(text(decodeFormatPrefix(hook).payload as any))).toStrictEqual({
      message,
    });
    // Each reader registers the payload under its event's id.
    const source = stateSourceId({
      eventType: 'hook_received',
      eventId: 'evnt_1',
    }) as string;
    body.addSource(source, read(hook, body));

    const v1 = read(output1, body).session;
    const s2 = produce(v1 as Session, (draft) => {
      draft.history.push({ role: 'user', content: message });
    });
    const output2 = write({ session: s2 }, body);
    expect(text(output2)).not.toContain('Weather in Oslo');
    expect(read(output2, body).session.history.at(-1).content).toBe(message);
    const recovered = cold(output1);
    recovered.ingest(
      decodeFormatPrefix(hook).payload as Uint8Array,
      {},
      source
    );
    expect(read(output2, recovered).session.history.at(-1).content).toBe(
      message
    );
  });

  it('resolves hook strings to what was stored even if the revived payload is edited', () => {
    const { output1 } = session();
    const message = 'Weather in Oslo for the next three days, please. '.repeat(
      4
    );
    const hook = write({ message }, new StateContext());
    const replay = new StateContext();
    const revived = read(hook, replay);
    replay.addSource('hook:evnt_2', revived);
    const v1 = read(output1, replay).session;
    const output2 = write(
      {
        session: produce(v1 as Session, (d) => {
          d.history.push({ role: 'user', content: message });
        }),
      },
      replay
    );
    revived.message = 'edited after it arrived';
    expect(read(output2, replay).session.history.at(-1).content).toBe(message);
  });

  it('never refers to a version that only a step input carried', () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session as Session;
    // A value made where its lineage is visible, but stored only in a step input.
    const local = produce(v1, (d) => {
      d.history.push({ role: 'user', content: 'only in an input' });
    });
    const inputA = workflow.serialize(
      { session: local },
      { stateContext: body, stateInput: true }
    );
    expect(text(inputA)).toContain('"patch"');
    // A later input of the same value is not a reference to step A's input.
    const inputB = workflow.serialize(
      { session: local },
      { stateContext: body, stateInput: true }
    );
    expect(text(inputB)).not.toContain('"ref"');
    // A cold step B rebuilds it from what readers see: outputs only.
    expect(
      workflow.deserialize(inputB, {
        stateContext: cold(output1),
        stateInput: true,
      })
    ).toStrictEqual({ session: local });

    // A step returning its input unchanged writes it whole, not a reference
    // to a version only that input carried.
    const step = new StateContext();
    step.ingest(decodeFormatPrefix(output1).payload as Uint8Array);
    const given = workflow.deserialize(inputA, {
      stateContext: step,
      stateInput: true,
    }) as { session: Session };
    const output = write(given, step);
    expect(text(output)).not.toContain('"ref"');
    expect(read(output, cold(output1))).toStrictEqual({ session: local });
  });

  it('writes and reads a long history in bounded time', () => {
    // Every write checks the whole value is frozen state; that check must stay
    // cheap per message (it once threw per child, which took ~80 s here).
    const writer = new StateContext();
    let history: readonly unknown[] = Object.freeze([]);
    const started = performance.now();
    for (let i = 0; i < 2_000; i++) {
      const next = Object.freeze([
        ...history,
        Object.freeze({ role: 'user', content: `message ${i}` }),
      ]);
      history = read(write({ history: next }, writer), writer).history;
    }
    expect(history).toHaveLength(2_000);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('measures a growing value only now and then to apply the snapshot rule', () => {
    const replay = new StateContext();
    let state = read(
      write({ s: produce({ log: [] as string[] }, () => {}) }, replay),
      replay
    ).s as { log: string[] };
    const measured: unknown[] = [];
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((
      value: unknown,
      ...rest: unknown[]
    ) => {
      if (value === state) measured.push(value);
      return (stringify as any)(value, ...rest);
    }) as typeof JSON.stringify);
    try {
      for (let i = 0; i < 300; i++) {
        state = produce(state, (d) => {
          d.log.push('x'.repeat(1024));
        });
        read(write({ s: state }, replay), replay);
      }
    } finally {
      spy.mockRestore();
    }
    // A growing value is not re-measured on every write once its changes
    // pass the threshold.
    expect(measured.length).toBeLessThan(20);
  });

  it('writes a growing value whole each time it doubles', () => {
    const replay = new StateContext();
    let state = produce({ log: [] as { t: string }[] }, () => {});
    const fullAt: number[] = [];
    const outputs: Uint8Array[] = [];
    for (let i = 0; i < 1_000; i++) {
      state = produce(state, (d) => {
        d.log.push({ t: 'x'.repeat(1024) });
      });
      const out = write({ s: state }, replay);
      if (text(out).includes('"full"')) fullAt.push(i);
      outputs.push(out);
      state = read(out, replay).s as typeof state;
    }
    // ~1 MB of appends: whole once the changes pass 64 KiB, then each time
    // the value doubles, so a rebuild applies at most about the value's own
    // size of changes.
    // Measured: whole at writes 0, 61, 122, 236, 456 and 879.
    expect(fullAt.length).toBeGreaterThanOrEqual(4);
    expect(fullAt.length).toBeLessThanOrEqual(7);
    for (let k = 2; k < fullAt.length; k++) {
      const ratio = (fullAt[k]! + 1) / (fullAt[k - 1]! + 1);
      expect(ratio).toBeGreaterThan(1.6);
      expect(ratio).toBeLessThan(2.4);
    }
    // A cold read rebuilds the same value from the log.
    const last = outputs.pop() as Uint8Array;
    expect(read(last, cold(...outputs)).s).toStrictEqual(state);
  });

  it('writes a value whole after 1000 small changes', () => {
    const replay = new StateContext();
    // `meta` is shared between versions, which links each to the previous.
    let state = produce({ n: 0, meta: { kind: 'counter' } }, () => {});
    let fulls = 0;
    for (let i = 0; i < 2_500; i++) {
      state = produce(state, (d) => {
        d.n++;
      });
      const out = write({ s: state }, replay);
      if (text(out).includes('"full"')) fulls++;
      state = read(out, replay).s as typeof state;
    }
    // The first write, then one every 1000 changes.
    expect(fulls).toBe(3);
  });

  it('needs recovery only for records a fresh context lacks', () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session;
    const whole = write({ session: v1 }, new StateContext());
    expect(text(whole)).toContain(STATE_REF_REDUCER);
    expect(
      new StateContext().needsRecovery(
        decodeFormatPrefix(whole).payload as Uint8Array
      )
    ).toBe(false);
    const ref = write({ session: v1 }, body);
    expect(
      new StateContext().needsRecovery(
        decodeFormatPrefix(ref).payload as Uint8Array
      )
    ).toBe(true);
  });

  it('needs recovery when another failure comes before a missing record', () => {
    // A whole value holding a type the scratch read can't revive, then a
    // reference this context lacks.
    const payload = new TextEncoder().encode(
      JSON.stringify([
        { a: 1, b: 7 },
        ['StateRefV1', 2],
        { kind: 3, logId: 4, version: 5, value: 6 },
        'full',
        'l',
        'v1',
        ['Mystery', 3],
        ['StateRefV1', 8],
        { kind: 9, logId: 4, version: 10 },
        'ref',
        'v2',
      ])
    );
    expect(new StateContext().needsRecovery(payload)).toBe(true);
  });

  it("writes no records for a step whose run can't read them", async () => {
    const frozen = produce({ list: [] as number[] }, (d) => {
      d.list.push(1);
    });
    const outputOf = async (global: Record<string, any>) => {
      const input = await dehydrateStepArguments(
        { args: [frozen], closureVars: undefined, thisVal: undefined },
        'wrun_1',
        undefined,
        global
      );
      const hydrated = await hydrateStepArguments(input, 'wrun_1', undefined);
      const out = await dehydrateStepReturnValue(
        produce(hydrated.args[0] as { list: number[] }, (d) => {
          d.list.push(2);
        }),
        'wrun_1',
        undefined,
        [],
        globalThis,
        false,
        false,
        false,
        undefined,
        [],
        false,
        stateContextForData(hydrated)
      );
      return text(out as Uint8Array);
    };
    // A Node VM workflow (a state context bound to its global) marks the input.
    const vm = Object.create(globalThis);
    bindStateContext(vm, new StateContext());
    expect(await outputOf(vm)).toContain('StateRefV1');
    // A QuickJS workflow doesn't, so the step writes plain values.
    expect(await outputOf(Object.create(globalThis))).not.toContain(
      'StateRefV1'
    );
  });

  it('writes run arguments and return values whole so they read without the run log', async () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session;
    const global = globalThis as Record<string, any>;
    bindStateContext(global, body);
    try {
      const returned = await dehydrateWorkflowReturnValue(
        { session: v1 },
        'wrun_1',
        undefined,
        global
      );
      // Plain values, readable by any client, with or without this support.
      expect(text(returned as Uint8Array)).not.toContain('StateRefV1');
      expect(
        (await hydrateWorkflowReturnValue(returned, 'wrun_1', undefined))
          .session
      ).toStrictEqual(v1);
      const args = await dehydrateWorkflowArguments(
        [v1],
        'wrun_2',
        undefined,
        [],
        global
      );
      expect(text(args as Uint8Array)).not.toContain('StateRefV1');
      expect(
        (await hydrateWorkflowArguments(args, 'wrun_2', undefined))[0]
      ).toStrictEqual(v1);
    } finally {
      bindStateContext(global, new StateContext());
    }
  });

  it('tracks only deeply frozen plain data', () => {
    const body = new StateContext();
    // Not frozen, or frozen only at the top: stored as before.
    expect(text(write({ s: { list: [1] } }, body))).not.toContain('StateRefV1');
    expect(
      text(write({ s: Object.freeze({ list: [1] }) }, body))
    ).not.toContain('StateRefV1');
    // Frozen, but holding a class instance: stored as before, so a cold step
    // never needs workflow code to rebuild it.
    class Point {
      constructor(readonly x: number) {}
    }
    const withClass = Object.freeze({ at: Object.freeze(new Point(1)) });
    expect(isFrozenState(withClass)).toBe(false);
    // Deeply frozen, with dates and maps trusted inside it: tracked.
    const tracked = produce({ at: new Date(0), tags: [] as string[] }, (d) => {
      d.tags.push('a');
    });
    expect(text(write({ s: tracked }, body))).toContain('"full"');
  });

  it('tracks frozen state whose dates, maps and sets come from the workflow VM', () => {
    // The workflow VM revives values with its own built-ins.
    const fromVm = runInNewContext(
      'Object.freeze({ at: new Date(0), tags: new Set(["a"]), byId: new Map(), bytes: new Uint8Array(2), list: Object.freeze([1]) })'
    );
    expect(isFrozenState(fromVm)).toBe(true);
  });

  it('refers to a known version for a frozen copy holding the same data', () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session as Session;
    // Rebuilt copies, but one part kept: that part identifies the version.
    const copy = produce(v1, () => ({
      history: structuredClone(v1.history) as Message[],
      context: v1.context,
    }));
    expect(copy).not.toBe(v1);
    expect(text(write({ session: copy }, body))).toContain('"ref"');
  });

  it('returns stored state frozen, so changing it in place throws', () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session as Session;
    expect(() => {
      (v1.history as Message[]).push({ role: 'user', content: 'x' });
    }).toThrow(TypeError);
  });

  it('writes hook payloads and other payloads outside the log as plain values', () => {
    const frozen = produce({ list: [1] }, (d) => {
      d.list.push(2);
    });
    // No context bound to this global: the payload isn't part of a run's log.
    const unbound = Object.create(globalThis);
    expect(
      text(workflow.serialize({ frozen }, { global: unbound }))
    ).not.toContain('StateRefV1');
    expect(
      text(
        workflow.serialize(
          { frozen },
          { stateContext: StateContext.standalone() }
        )
      )
    ).not.toContain('StateRefV1');
  });

  it('tracks an object in a later payload even if an earlier one held it inside a record', () => {
    const body = new StateContext();
    const inner = produce({ items: [] as number[] }, (d) => {
      d.items.push(1);
    });
    const outer = produce({ inner, n: 0 }, (d) => {
      d.n = 1;
    });
    write({ outer }, body);
    // `inner` was written inside `outer`'s record; on its own it is tracked.
    expect(text(write({ inner }, body))).toContain('StateRefV1');
  });

  it('writes a known version held inside a new value as its own reference', () => {
    const body = new StateContext();
    const inner = read(
      write(
        {
          s: produce({ n: 0 }, (d) => {
            d.n = 1;
          }),
        },
        body
      ),
      body
    ).s as { n: number };
    const outer = produce({ inner, label: 'a' }, (d) => {
      d.label = 'b';
    });
    const out = text(write({ outer }, body));
    // The new value is stored whole, holding a reference to the known one.
    expect(out).toContain('"full"');
    expect(out).toContain('"ref"');
    expect(out).not.toContain('"patch"');
  });

  it('stores a change from the step input for state made only of strings and numbers', () => {
    const replay = new StateContext();
    const first = write(
      {
        s: produce({ blob: '', log: [] as string[] }, (d) => {
          d.blob = 'a';
        }),
      },
      replay
    );
    const v1 = read(first, replay).s;
    // The step reads it as its input, then returns a value sharing no objects.
    const input = workflow.serialize(
      { s: v1 },
      { stateContext: replay, stateInput: true }
    );
    const given = workflow.deserialize(input, {
      stateContext: replay,
      stateInput: true,
    }) as { s: { blob: string; log: string[] } };
    const out = write(
      {
        s: produce(given.s, (d) => {
          d.blob = 'b';
          d.log.push('w1');
        }),
      },
      replay
    );
    expect(text(out)).toContain('"patch"');
    expect(read(out, cold(first)).s).toEqual({
      blob: 'b',
      log: ['w1'],
    });
  });

  it('stores a value whole when none of its objects are shared with a known version', () => {
    const body = new StateContext();
    const v1 = read(
      write(
        {
          s: produce({ n: 0 }, (d) => {
            d.n = 1;
          }),
        },
        body
      ),
      body
    ).s;
    const out = write(
      {
        s: produce(v1 as { n: number }, (d) => {
          d.n = 2;
        }),
      },
      body
    );
    expect(text(out)).toContain('"full"');
    expect(read(out, new StateContext()).s).toEqual({ n: 2 });
  });

  it('stores a value whole again once its overwrites outgrow it', () => {
    const body = new StateContext();
    let value = read(
      write(
        {
          // `meta` stays the same object, so each new value is found to
          // come from the previous one.
          s: produce({ blob: '', meta: { id: 1 } }, (d) => {
            d.blob = 'x'.repeat(20_000);
          }),
        },
        body
      ),
      body
    ).s;
    const kinds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const out = write(
        {
          s: produce(value as { blob: string; meta: { id: number } }, (d) => {
            d.blob = String(i).repeat(20_000);
          }),
        },
        body
      );
      kinds.push(text(out).includes('"full"') ? 'full' : 'patch');
      value = read(out, body).s;
    }
    expect(kinds[0]).toBe('patch');
    expect(kinds).toContain('full');
    // Changes count from the whole copy again, as a replay of this log would count them.
    expect(kinds[kinds.indexOf('full') + 1]).toBe('patch');
    expect(kinds.filter((kind) => kind === 'full').length).toBeLessThan(4);
  });

  it('writes a value whole where its base is unknown, and fails on a missing version', () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session;
    const elsewhere = write({ session: v1 }, new StateContext());
    expect(text(elsewhere)).toContain('"full"');
    expect(read(elsewhere, new StateContext()).session).toStrictEqual(v1);
    expect(() =>
      read(write({ session: v1 }, body), new StateContext())
    ).toThrow(/Missing workflow state version/);
  });

  it('recovers null-prototype dictionaries cold, as eve stores them', () => {
    const body = new StateContext();
    const entries = Object.assign(Object.create(null), {
      'turn:1': { kind: 'turn' },
    });
    const first = write(
      { s: produce({ context: { entries } }, () => {}) },
      body
    );
    const v1 = read(first, body).s;
    const second = write(
      {
        s: produce(
          v1 as { context: { entries: Record<string, unknown> } },
          (d) => {
            d.context.entries['turn:2'] = { kind: 'turn' };
          }
        ),
      },
      body
    );
    const input = write({ s: read(second, body).s }, body);
    const retried = read(input, cold(first, second)).s;
    expect(Object.getPrototypeOf(retried.context.entries)).toBe(null);
    expect(Object.keys(retried.context.entries)).toEqual(['turn:1', 'turn:2']);
  });

  it('recovers dates and bytes, and refuses values only workflow code could rebuild', () => {
    const body = new StateContext();
    const v0 = read(
      write({ s: produce({ items: [] as unknown[] }, () => {}) }, body),
      body
    ).s;
    const first = write(
      {
        s: produce(v0 as { items: unknown[] }, (d) => {
          d.items.push(1);
        }),
      },
      body
    );
    const v1 = read(first, body).s;
    const at = new Date('2026-11-03T00:00:00Z');
    const second = write(
      {
        s: produce(v1 as { items: unknown[] }, (d) => {
          d.items.push(at, new Uint8Array([1, 2]));
        }),
      },
      body
    );
    const recovered = read(
      write({ s: read(second, body).s }, body),
      cold(first, second)
    ).s;
    expect(recovered.items[1]).toEqual(at);
    expect(recovered.items[2]).toEqual(new Uint8Array([1, 2]));

    const unknown = new TextEncoder().encode(
      JSON.stringify([
        ['StateRefV1', 1],
        { kind: 2, logId: 3, version: 4, value: 5 },
        'full',
        'l',
        'v',
        ['Somewhere', 6],
        0,
      ])
    );
    expect(() => new StateContext().ingest(unknown)).toThrow(
      /cannot be recovered/
    );

    // Only a change's new data is checked, so it must be rejected there too.
    const context = new StateContext();
    const encode = (records: unknown[]) =>
      new TextEncoder().encode(JSON.stringify(records));
    context.ingest(
      encode([
        ['StateRefV1', 1],
        { kind: 2, logId: 3, version: 4, value: 5 },
        'full',
        'l',
        'v0',
        { items: 6 },
        [],
      ])
    );
    const patch = encode([
      ['StateRefV1', 1],
      { kind: 2, logId: 3, base: 4, version: 5, ops: 6 },
      'patch',
      'l',
      'v0',
      'v1',
      [7],
      { op: 8, path: 9, items: 10 },
      'append',
      [11],
      [12],
      'items',
      ['Somewhere', 13],
      0,
    ]);
    expect(() => context.ingest(patch)).toThrow(/cannot be recovered/);
  });
});
