import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { dehydrateStepArguments } from '../serialization.js';
import { createContext, freezeSerializationIntrinsics } from '../vm/index.js';
import { isRetainedSerializationPassive } from './retained-step-input.js';

const seed = 'retained-step-input';
const fixedTimestamp = 1_700_000_000_000;

function makeContext({ freeze = true } = {}) {
  const { context, globalThis: workflowGlobal } = createContext({
    seed,
    fixedTimestamp,
  });
  // Mimic the globals workflow.ts installs before any serialization happens
  // (the stream/request reducers dispatch on them unguarded).
  for (const name of [
    'ReadableStream',
    'WritableStream',
    'TransformStream',
    'Request',
    'Response',
    'AbortController',
    'AbortSignal',
  ]) {
    if ((workflowGlobal as any)[name] === undefined) {
      (workflowGlobal as any)[name] = (globalThis as any)[name];
    }
  }
  if (freeze) freezeSerializationIntrinsics(workflowGlobal);
  return { context, workflowGlobal };
}

describe('isRetainedSerializationPassive', () => {
  it('accepts plain cross-realm data', () => {
    const { context, workflowGlobal } = makeContext();
    const value = vm.runInContext(
      `({
        nested: [{ ok: true }, "text", 42n],
        sparse: [1, , 3],
        flag: false,
      })`,
      context
    );

    expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(true);
  });

  it('accepts the supported built-ins on a frozen realm', () => {
    const { context, workflowGlobal } = makeContext();
    for (const expression of [
      'new Map([["k", { ok: true }]])',
      'new Set([1, "two"])',
      'new Date(1234)',
      'new Uint8Array([1, 2, 3])',
      'new Float32Array([1.5])',
      'new ArrayBuffer(8)',
      '({ when: new Date(0), bytes: new Uint8Array(2), index: new Map() })',
    ]) {
      const value = vm.runInContext(expression, context);
      expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(true);
    }
  });

  it('accepts host-realm plain data but not host-realm built-ins', () => {
    const { workflowGlobal } = makeContext();
    // Hydrated step results are host-realm plain objects/arrays.
    expect(
      isRetainedSerializationPassive({ nested: [{ ok: true }] }, workflowGlobal)
    ).toBe(true);
    // Host built-in prototypes cannot be frozen (process-shared) and are
    // reachable from workflow code, so host-realm instances decline.
    expect(
      isRetainedSerializationPassive(new Map([['k', 1]]), workflowGlobal)
    ).toBe(false);
    expect(isRetainedSerializationPassive(new Date(0), workflowGlobal)).toBe(
      false
    );
  });

  it('declines types whose serialization surface is not frozen', () => {
    const { context, workflowGlobal } = makeContext();
    for (const expression of [
      '/workflow/gi',
      'new DataView(new ArrayBuffer(8))',
      'new SharedArrayBuffer(8)',
      'new Uint8Array(new SharedArrayBuffer(4))',
      'new Error("boom")',
      'new (class Sub extends Map {})()',
      'Object.assign(new Map(), { expando: 1 })',
      'Object.create(null)',
    ]) {
      const value = vm.runInContext(expression, context);
      expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(false);
    }
  });

  it('declines accessors without invoking them', () => {
    const { context, workflowGlobal } = makeContext();
    const value = vm.runInContext(
      `(() => {
        globalThis.__retainedTestCalls = 0;
        return { get value() { globalThis.__retainedTestCalls++; return 1; } };
      })()`,
      context
    );

    expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(false);
    expect(vm.runInContext('globalThis.__retainedTestCalls', context)).toBe(0);
  });

  it('declines proxies without invoking their traps', () => {
    const { context, workflowGlobal } = makeContext();
    const value = vm.runInContext(
      `(() => {
        globalThis.__retainedTestCalls = 0;
        return new Proxy({ value: 1 }, {
          ownKeys(target) {
            globalThis.__retainedTestCalls++;
            return Reflect.ownKeys(target);
          }
        });
      })()`,
      context
    );

    expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(false);
    expect(vm.runInContext('globalThis.__retainedTestCalls', context)).toBe(0);
  });

  it('declines custom class serializers without invoking them', () => {
    const { context, workflowGlobal } = makeContext();
    const value = vm.runInContext(
      `(() => {
        globalThis.__retainedTestCalls = 0;
        class Value {
          static classId = "test/Value";
          static [Symbol.for("workflow-serialize")](instance) {
            globalThis.__retainedTestCalls++;
            return { value: instance.value };
          }
          constructor(value) { this.value = value; }
        }
        return new Value(1);
      })()`,
      context
    );

    expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(false);
    expect(vm.runInContext('globalThis.__retainedTestCalls', context)).toBe(0);
  });

  it('declines hidden own keys (symbols, non-enumerables, constructor)', () => {
    const { context, workflowGlobal } = makeContext();
    for (const expression of [
      `(() => {
        const tagged = { plain: true };
        Object.defineProperty(tagged, Symbol.for("WORKFLOW_ABORT_STREAM_NAME"), {
          value: "abort-stream", enumerable: false,
        });
        return tagged;
      })()`,
      `(() => {
        const hidden = { plain: true };
        Object.defineProperty(hidden, "signal", {
          get() { return { aborted: false }; }, enumerable: false,
        });
        return hidden;
      })()`,
      `(() => {
        const arr = [1];
        Object.defineProperty(arr, "constructor", {
          value: class Fake { static classId = "fake"; }, enumerable: false,
        });
        return arr;
      })()`,
      `(() => {
        const arr = [1, 2];
        Object.defineProperty(arr, "0", { value: 7, enumerable: false });
        return arr;
      })()`,
    ]) {
      const value = vm.runInContext(expression, context);
      expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(false);
    }
  });

  it('freezing makes prototype patches impossible, so retention persists', () => {
    const { context, workflowGlobal } = makeContext();
    const map = vm.runInContext('new Map([["k", 1]])', context);
    expect(isRetainedSerializationPassive(map, workflowGlobal)).toBe(true);

    // Redefining a member the serializer reads throws on the frozen prototype.
    for (const attempt of [
      '"use strict"; Object.defineProperty(Map.prototype, "constructor", { get() { return 1; } })',
      '"use strict"; Map.prototype[Symbol.iterator] = function () {};',
      '"use strict"; Date.prototype.toISOString = function () { return "x"; };',
      '"use strict"; Object.defineProperty(Float32Array.prototype, "buffer", { get() {} })',
    ]) {
      expect(() => vm.runInContext(attempt, context)).toThrow(
        /not extensible|read only|Cannot redefine/
      );
    }
    // Nothing changed, so the built-ins remain retainable.
    expect(isRetainedSerializationPassive(map, workflowGlobal)).toBe(true);
  });

  it('declines built-ins when the realm was never frozen', () => {
    const { context, workflowGlobal } = makeContext({ freeze: false });
    const map = vm.runInContext('new Map()', context);
    expect(isRetainedSerializationPassive(map, workflowGlobal)).toBe(false);
    // Plain data does not depend on the built-in prototypes.
    const plain = vm.runInContext('({ ok: true })', context);
    expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(true);
  });

  it('declines retention while a host dispatch constructor is hooked', () => {
    const { context, workflowGlobal } = makeContext();
    const plain = vm.runInContext('({ ok: true })', context);
    expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(true);

    Object.defineProperty(Headers, Symbol.hasInstance, {
      value: () => false,
      configurable: true,
    });
    try {
      expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(false);
    } finally {
      delete (Headers as any)[Symbol.hasInstance];
    }

    expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(true);
  });
});

describe('serialization touches only the frozen surface', () => {
  // THE coupling test: retention is only sound if every prototype member
  // `dehydrateStepArguments` executes for the supported built-ins lives on an
  // object `freezeSerializationIntrinsics` freezes. Wrap every configurable
  // member on the relevant prototypes (in an unfrozen realm) with a recorder
  // and assert the serializer hits nothing beyond this measured set — every
  // entry of which is on a frozen prototype in production. If serde starts
  // touching something new, this fails loudly: extend the freeze (and this
  // list) together.
  const FROZEN_SURFACE = new Set([
    'Map.prototype.Symbol(Symbol.iterator)',
    '%MapIteratorPrototype%.next',
    'Set.prototype.Symbol(Symbol.iterator)',
    '%SetIteratorPrototype%.next',
    'Date.prototype.getDate',
    'Date.prototype.toISOString',
    '%TypedArray%.prototype.buffer',
    '%TypedArray%.prototype.byteOffset',
    '%TypedArray%.prototype.byteLength',
    'ArrayBuffer.prototype.byteLength',
  ]);

  it('for Map, Set, Date, typed arrays, and ArrayBuffer', async () => {
    // Unfrozen realm: the recorders themselves need to redefine members.
    const { context, workflowGlobal } = makeContext({ freeze: false });
    const g = workflowGlobal as any;
    const touched = new Set<string>();

    const wrapPrototype = (prototype: object, label: string) => {
      for (const key of Reflect.ownKeys(prototype)) {
        if (key === 'constructor') continue;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
        if (!descriptor || !descriptor.configurable) continue;
        const name = `${label}.${String(key)}`;
        if (typeof descriptor.value === 'function') {
          const original = descriptor.value;
          Object.defineProperty(prototype, key, {
            ...descriptor,
            value: function (this: unknown, ...args: unknown[]) {
              touched.add(name);
              return original.apply(this, args);
            },
          });
        } else if (descriptor.get) {
          const originalGet = descriptor.get;
          Object.defineProperty(prototype, key, {
            ...descriptor,
            get() {
              touched.add(name);
              return originalGet.call(this);
            },
            set: descriptor.set,
          });
        }
      }
    };

    const values = vm.runInContext(
      `({
        map: new Map([["k", 1]]),
        set: new Set([1, 2]),
        date: new Date(1234),
        f32: new Float32Array([1.5, 2.5]),
        u8: new Uint8Array([1, 2, 3]),
        ab: new ArrayBuffer(8),
      })`,
      context
    );

    wrapPrototype(g.Map.prototype, 'Map.prototype');
    wrapPrototype(
      Object.getPrototypeOf(new g.Map()[Symbol.iterator]()),
      '%MapIteratorPrototype%'
    );
    wrapPrototype(g.Set.prototype, 'Set.prototype');
    wrapPrototype(
      Object.getPrototypeOf(new g.Set()[Symbol.iterator]()),
      '%SetIteratorPrototype%'
    );
    const datePrototype = Object.getOwnPropertyDescriptor(g.Date, 'prototype')!
      .value as object;
    wrapPrototype(datePrototype, 'Date.prototype');
    wrapPrototype(
      Object.getPrototypeOf(g.Uint8Array.prototype),
      '%TypedArray%.prototype'
    );
    wrapPrototype(g.Uint8Array.prototype, 'Uint8Array.prototype');
    wrapPrototype(g.Float32Array.prototype, 'Float32Array.prototype');
    wrapPrototype(g.ArrayBuffer.prototype, 'ArrayBuffer.prototype');

    for (const value of Object.values(values as Record<string, unknown>)) {
      touched.clear();
      await dehydrateStepArguments(
        { args: [value], closureVars: undefined, thisVal: undefined },
        'wrun_pin_coverage',
        undefined,
        g,
        false,
        false
      );
      for (const name of touched) {
        expect(
          FROZEN_SURFACE,
          `member outside the frozen surface executed: ${name}`
        ).toContain(name);
      }
    }
  });
});

describe('checker execution surface', () => {
  it('never invokes live host collection methods', () => {
    const { context, workflowGlobal } = makeContext();
    const map = vm.runInContext('new Map([["k", 1]])', context);

    let invoked = 0;
    const original = Map.prototype.forEach;
    // Simulate workflow code having replaced the reachable host method.
    Map.prototype.forEach = function (
      this: Map<unknown, unknown>,
      ...args: [any]
    ) {
      invoked++;
      return original.apply(this, args);
    };
    try {
      // The checker uses the module-captured primordial: same verdict,
      // replaced method never runs.
      expect(isRetainedSerializationPassive(map, workflowGlobal)).toBe(true);
      expect(invoked).toBe(0);
    } finally {
      Map.prototype.forEach = original;
    }
  });

  it('declines typed arrays re-prototyped onto a frozen hostile prototype', () => {
    const { context, workflowGlobal } = makeContext();
    const value = vm.runInContext(
      `(() => {
        globalThis.__retainedTestCalls = 0;
        const realGetter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(Uint8Array.prototype), "buffer").get;
        const hostile = Object.create(
          Object.getPrototypeOf(Uint8Array.prototype),
          { buffer: { get() { globalThis.__retainedTestCalls++; return realGetter.call(this); } } }
        );
        Object.freeze(hostile);
        const ta = new Uint8Array([1, 2]);
        Object.setPrototypeOf(ta, hostile);
        return ta;
      })()`,
      context
    );

    expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(false);
    expect(vm.runInContext('globalThis.__retainedTestCalls', context)).toBe(0);
  });
});

describe('bigint serialization', () => {
  it('declines retention while host BigInt.prototype.toString is replaced', () => {
    const { context, workflowGlobal } = makeContext();
    const value = vm.runInContext('({ big: 42n })', context);
    expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(true);

    const original = BigInt.prototype.toString;
    // biome-ignore lint/suspicious/noGlobalAssign: simulating workflow-realm tampering
    BigInt.prototype.toString = function (this: bigint, ...args: [number?]) {
      return original.apply(this, args);
    };
    try {
      expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(false);
    } finally {
      BigInt.prototype.toString = original;
    }

    expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(true);
  });
});

describe('walker primordials', () => {
  it('uses captured primordials, not live host statics', () => {
    const { context, workflowGlobal } = makeContext();
    const map = vm.runInContext('new Map([["k", { ok: true }]])', context);

    // If the walker consulted the live host statics, these would throw.
    const originalDescriptor = Object.getOwnPropertyDescriptor;
    const originalOwnKeys = Reflect.ownKeys;
    (Object as any).getOwnPropertyDescriptor = () => {
      throw new Error('live getOwnPropertyDescriptor used');
    };
    (Reflect as any).ownKeys = () => {
      throw new Error('live ownKeys used');
    };
    try {
      expect(isRetainedSerializationPassive(map, workflowGlobal)).toBe(true);
    } finally {
      (Object as any).getOwnPropertyDescriptor = originalDescriptor;
      (Reflect as any).ownKeys = originalOwnKeys;
    }
  });

  it('declines when host Function.prototype carries serializer statics', () => {
    const { context, workflowGlobal } = makeContext();
    const plain = vm.runInContext('({ ok: true })', context);
    expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(true);

    Object.defineProperty(
      Function.prototype,
      Symbol.for('workflow-serialize'),
      {
        get() {
          return undefined;
        },
        configurable: true,
      }
    );
    try {
      expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(false);
    } finally {
      delete (Function.prototype as any)[Symbol.for('workflow-serialize')];
    }

    expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(true);
  });
});
