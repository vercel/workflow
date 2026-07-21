import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { dehydrateStepArguments } from '../serialization.js';
import { createContext } from '../vm/index.js';
import { isRetainedSerializationPassive } from './retained-step-input.js';

const seed = 'retained-step-input';
const fixedTimestamp = 1_700_000_000_000;

function makeContext() {
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

  it('accepts the supported built-ins with pristine pins', () => {
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

  it('accepts host-realm instances (hydrated step results)', () => {
    const { workflowGlobal } = makeContext();
    const value = {
      map: new Map([['k', 1]]),
      date: new Date(1234),
      bytes: new Uint8Array([9]),
    };

    expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(true);
  });

  it('declines types whose serialization is not pinned', () => {
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

  it('declines everything once a pinned member is patched', () => {
    const { context, workflowGlobal } = makeContext();
    const plain = vm.runInContext('({ ok: true })', context);
    expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(true);

    vm.runInContext(
      `globalThis.__origIterator = Map.prototype[Symbol.iterator];
       Map.prototype[Symbol.iterator] = function () { return globalThis.__origIterator.call(this); };`,
      context
    );
    expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(false);

    vm.runInContext(
      'Map.prototype[Symbol.iterator] = globalThis.__origIterator;',
      context
    );
    expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(true);
  });

  it('declines per pinned member: iterator next, Date methods', () => {
    for (const patch of [
      'Object.getPrototypeOf((new Map())[Symbol.iterator]()).next = function () {};',
      'Object.getPrototypeOf((new Set())[Symbol.iterator]()).next = function () {};',
      'Date.prototype.toISOString = function () { return "spoofed"; };',
      'Date.prototype.getDate = function () { return 1; };',
    ]) {
      const { context, workflowGlobal } = makeContext();
      const plain = vm.runInContext('({ ok: true })', context);
      vm.runInContext(patch, context);
      expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(false);
    }
  });

  it('declines typed arrays whose subclass prototype shadows a pinned getter', () => {
    const { context, workflowGlobal } = makeContext();
    const value = vm.runInContext(
      `(() => {
        Object.defineProperty(Float32Array.prototype, "buffer", {
          get() { return new ArrayBuffer(0); }, configurable: true,
        });
        return new Float32Array([1.5]);
      })()`,
      context
    );

    expect(isRetainedSerializationPassive(value, workflowGlobal)).toBe(false);
    // Pins themselves are intact, so unrelated values stay retainable.
    const plain = vm.runInContext('({ ok: true })', context);
    expect(isRetainedSerializationPassive(plain, workflowGlobal)).toBe(true);
  });
});

describe('serialization touches only pinned members', () => {
  // THE coupling test: the pin list in vm/serialization-pins.ts is only sound
  // if it covers every prototype member `dehydrateStepArguments` executes for
  // the supported built-ins. Wrap every configurable member on the relevant
  // prototypes with a recorder and assert the serializer hits nothing beyond
  // the pinned set. If serde changes what it touches, this fails loudly —
  // update the pin list (and this list) together.
  const PINNED = new Set([
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
    const { context, workflowGlobal } = makeContext();
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
        expect(PINNED, `unpinned member executed: ${name}`).toContain(name);
      }
    }
  });
});
