import { runInNewContext } from 'node:vm';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { applyStateOps, diffState, sameState } from './state.js';

describe('recorded changes', () => {
  it('records growth at the end of an array as one append and other changes per path', () => {
    const base = Object.assign(Object.create(null), {
      a: 1,
      b: { c: [1, 2] },
      gone: true,
    });
    const next = produce(base, (draft: any) => {
      draft.a = 2;
      draft.b.c.push(3, 4);
      delete draft.gone;
      draft.added = 'x';
    });
    const ops = diffState(base, next);
    expect(ops).toEqual([
      { op: 'del', path: ['gone'] },
      { op: 'set', path: ['a'], value: 2 },
      { op: 'append', path: ['b', 'c'], items: [3, 4] },
      { op: 'set', path: ['added'], value: 'x' },
    ]);
    const rebuilt = applyStateOps(base, ops) as Record<string, unknown>;
    expect({ ...rebuilt }).toEqual({ ...next });
    expect(Object.getPrototypeOf(rebuilt)).toBe(null);
  });

  it('replaces an array that did not only grow at the end', () => {
    const base = { history: [1, 2, 3] };
    const next = produce(base, (draft) => {
      draft.history = [9];
    });
    expect(diffState(base, next)).toEqual([
      { op: 'set', path: ['history'], value: [9] },
    ]);
  });

  it('applies changes without editing the base', () => {
    const base = Object.freeze({ list: Object.freeze([1]) });
    const next = applyStateOps(base, [
      { op: 'append', path: ['list'], items: [2] },
    ]);
    expect(next).toEqual({ list: [1, 2] });
    expect(base.list).toEqual([1]);
  });
});

describe('reserved keys', () => {
  it('round-trips own properties named __proto__, constructor and prototype', () => {
    const base = JSON.parse(
      '{"__proto__":{"a":1},"constructor":"x","prototype":[1]}'
    );
    const next = produce(base, (draft: any) => {
      draft.constructor = 'y';
      draft.prototype.push(2);
      draft.__proto__.a = 2;
    });
    const rebuilt = applyStateOps(base, diffState(base, next)) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(rebuilt)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(rebuilt).sort()).toEqual([
      '__proto__',
      'constructor',
      'prototype',
    ]);
    expect(
      Object.getOwnPropertyDescriptor(rebuilt, '__proto__')?.value
    ).toEqual({ a: 2 });
    expect(rebuilt.constructor).toBe('y');
    expect(rebuilt.prototype).toEqual([1, 2]);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });
});

describe('values rebuilt as copies', () => {
  it('records only what differs when the recipe returns copies', () => {
    const base = {
      history: [{ role: 'user', content: 'a' }],
      state: { runs: [1], status: 'idle' },
    };
    const copy = structuredClone(base);
    const next = produce(base, () => ({
      history: [...copy.history, { role: 'assistant', content: 'b' }],
      state: { runs: [...copy.state.runs, 2], status: 'idle' },
    }));
    expect(diffState(base, next)).toEqual([
      {
        op: 'append',
        path: ['history'],
        items: [{ role: 'assistant', content: 'b' }],
      },
      { op: 'append', path: ['state', 'runs'], items: [2] },
    ]);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it('records no change for a rebuilt copy that holds the same data', () => {
    const base = { at: new Date(0), list: [{ a: 1 }] };
    expect(diffState(base, structuredClone(base))).toEqual([]);
  });
});

describe('sparse arrays', () => {
  it('records filling a hole', () => {
    const base = { values: new Array<string>(2) };
    const next = produce(base, (draft) => {
      draft.values[0] = 'hello';
    });
    expect(next.values[0]).toBe('hello');
    expect(1 in next.values).toBe(false);
    const rebuilt = applyStateOps(base, diffState(base, next)) as typeof base;
    expect(rebuilt.values[0]).toBe('hello');
    expect(1 in rebuilt.values).toBe(false);
  });

  it('tells a hole from an explicit undefined', () => {
    const base = { values: new Array<unknown>(1) };
    const next = produce(base, (draft) => {
      draft.values[0] = undefined;
    });
    const rebuilt = applyStateOps(base, diffState(base, next)) as typeof base;
    expect(0 in rebuilt.values).toBe(true);
  });

  it('records a replacement that fills a hole', () => {
    const base = { values: new Array<string>(2) };
    const filled = new Array<string>(2);
    filled[0] = 'hello';
    const next = produce(base, () => ({ values: filled }));
    expect(next).not.toBe(base);
    expect(diffState(base, next)).toEqual([
      { op: 'set', path: ['values'], value: filled },
    ]);
  });

  it('keeps holes when appending after them', () => {
    const values: unknown[] = [1];
    values[2] = 3;
    const base = { values };
    const next = produce(base, (draft) => {
      draft.values.push(4);
    });
    const rebuilt = applyStateOps(base, diffState(base, next)) as typeof base;
    expect(rebuilt.values).toHaveLength(4);
    expect(1 in rebuilt.values).toBe(false);
    expect(rebuilt.values[3]).toBe(4);
  });
});

describe('key order', () => {
  it('records a new key order so replay rebuilds the same object', () => {
    const base = { a: 1, b: 2, c: 3 };
    const next = produce(base, () => ({ c: 3, a: 1, b: 2 }));
    const ops = diffState(base, next);
    expect(ops).toEqual([{ op: 'order', path: [], keys: ['c', 'a', 'b'] }]);
    expect(Object.keys(applyStateOps(base, ops) as object)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('keeps the order of a key deleted and added again', () => {
    const base = { state: { x: 1, y: 2 } };
    const next = produce(base, (draft: any) => {
      delete draft.state.x;
      draft.state.x = 5;
    });
    const rebuilt = applyStateOps(base, diffState(base, next)) as typeof base;
    expect(Object.keys(rebuilt.state)).toEqual(['y', 'x']);
    expect(rebuilt.state).toEqual({ y: 2, x: 5 });
  });

  it('keeps key order inside items an append treats as unchanged', () => {
    const base = { list: [{ a: 1, b: 2 }] };
    const next = produce(base, () => ({
      list: [
        { b: 2, a: 1 },
        { a: 3, b: 4 },
      ],
    }));
    const rebuilt = applyStateOps(base, diffState(base, next)) as typeof base;
    expect(Object.keys(rebuilt.list[0] as object)).toEqual(['b', 'a']);
    expect(rebuilt.list).toHaveLength(2);
  });

  it('records nothing extra when keys are only added at the end', () => {
    const base = { a: 1 };
    const next = produce(base, (draft: any) => {
      draft.b = 2;
    });
    expect(diffState(base, next)).toEqual([
      { op: 'set', path: ['b'], value: 2 },
    ]);
  });

  it('diffs objects from another realm, such as the workflow VM', () => {
    const base = Object.freeze({
      history: Object.freeze([Object.freeze({ c: 0 })]),
    });
    // Made in workflow code: the objects carry the VM's Object.prototype.
    const next = runInNewContext(
      'Object.freeze({ history: Object.freeze([...base.history, Object.freeze({ c: 1 })]) })',
      { base }
    );
    expect(Object.getPrototypeOf(next)).not.toBe(Object.prototype);
    expect(diffState(base, next)).toEqual([
      { op: 'append', path: ['history'], items: [{ c: 1 }] },
    ]);
    expect(sameState(base, runInNewContext('({ history: [{ c: 0 }] })'))).toBe(
      true
    );
    // A null-prototype dictionary still differs from an ordinary object.
    const dict = Object.assign(Object.create(null), { a: 1 });
    expect(sameState({ a: 1 }, dict)).toBe(false);
    expect(diffState({ a: 1 }, dict)).toEqual([
      { op: 'set', path: [], value: dict },
    ]);
  });
});
