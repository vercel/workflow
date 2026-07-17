import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import * as stepSerialization from '../serialization/step.js';
import { createContext } from '../vm/index.js';
import { prepareRetainedStepInput } from './retained-step-input.js';

const seed = 'retained-step-input';
const fixedTimestamp = 1_700_000_000_000;

describe('prepareRetainedStepInput', () => {
  it('clones passive cross-realm data into the host realm', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    const value = vm.runInContext(
      `({
        nested: [{ ok: true }, "text", 42n],
        sparse: [1, , 3],
        flag: false,
      })`,
      context
    );

    const prepared = prepareRetainedStepInput(value, workflowGlobal);

    expect(prepared.retainable).toBe(true);
    if (!prepared.retainable) return;
    expect(prepared.value).toEqual({
      nested: [{ ok: true }, 'text', 42n],
      sparse: [1, undefined, 3],
      flag: false,
    });
    // The clone's prototype chain lives in a pristine realm: not the
    // workflow realm, not the host realm.
    const cloneProto = Object.getPrototypeOf(prepared.value);
    expect(cloneProto).not.toBe(Object.prototype);
    expect(Object.getPrototypeOf(cloneProto)).toBe(null);
  });

  it('produces the same serialized bytes as ordinary VM traversal', async () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    const value = vm.runInContext(
      `({
        nested: [{ ok: true, missing: undefined }],
        sparse: [1, , 3],
        big: 42n,
        text: "workflow",
      })`,
      context
    );
    const prepared = prepareRetainedStepInput(value, workflowGlobal);
    expect(prepared.retainable).toBe(true);
    if (!prepared.retainable) return;

    const original = await stepSerialization.serialize(value, undefined, {
      global: workflowGlobal,
    });
    const cloned = await stepSerialization.serialize(
      prepared.value,
      undefined,
      { global: globalThis }
    );

    expect(cloned).toEqual(original);
  });

  it('declines arrays with an own constructor property', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    const value = vm.runInContext(
      `(() => {
        const arr = [1];
        Object.defineProperty(arr, "constructor", {
          value: class Fake { static classId = "fake"; },
          enumerable: false,
        });
        return arr;
      })()`,
      context
    );

    expect(prepareRetainedStepInput(value, workflowGlobal)).toEqual({
      retainable: false,
    });
  });

  it('declines built-ins whose serialization consults realm prototypes', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    for (const expression of [
      'new Map([["k", 1]])',
      'new Set([1, 2])',
      'new Date(1234)',
      '/workflow/gi',
      'new Uint8Array([1, 2])',
      'new ArrayBuffer(8)',
      'new DataView(new ArrayBuffer(8))',
      'new Error("boom")',
      'Object.assign(Object.create(Object.prototype), { m: new Map() })',
    ]) {
      const value = vm.runInContext(expression, context);
      expect(prepareRetainedStepInput(value, workflowGlobal)).toEqual({
        retainable: false,
      });
    }
  });

  it('declines accessors without invoking them', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    const value = vm.runInContext(
      `(() => {
        globalThis.__retainedTestCalls = 0;
        return { get value() { globalThis.__retainedTestCalls++; return 1; } };
      })()`,
      context
    );

    expect(prepareRetainedStepInput(value, workflowGlobal)).toEqual({
      retainable: false,
    });
    expect(vm.runInContext('globalThis.__retainedTestCalls', context)).toBe(0);
  });

  it('declines proxies without invoking their traps', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
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

    expect(prepareRetainedStepInput(value, workflowGlobal)).toEqual({
      retainable: false,
    });
    expect(vm.runInContext('globalThis.__retainedTestCalls', context)).toBe(0);
  });

  it('declines custom class serializers without invoking them', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
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

    expect(prepareRetainedStepInput(value, workflowGlobal)).toEqual({
      retainable: false,
    });
    expect(vm.runInContext('globalThis.__retainedTestCalls', context)).toBe(0);
  });
});

describe('prepareRetainedStepInput review-hardening', () => {
  it('declines non-enumerable array indices (structuredClone would drop them)', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    const value = vm.runInContext(
      `(() => {
        const arr = [1, 2];
        Object.defineProperty(arr, "0", { value: 7, enumerable: false });
        return arr;
      })()`,
      context
    );

    expect(prepareRetainedStepInput(value, workflowGlobal)).toEqual({
      retainable: false,
    });
  });

  it('never performs a property Get on redefined workflow globals', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    const value = vm.runInContext(
      `(() => {
        globalThis.__retainedTestCalls = 0;
        const arr = [1];
        for (const name of ["Array", "Object"]) {
          Object.defineProperty(globalThis, name, {
            get() { globalThis.__retainedTestCalls++; throw new Error("boom"); },
          });
        }
        return { arr };
      })()`,
      context
    );

    // The vandalized globals make the VM-realm prototypes unverifiable, so
    // validation declines — without throwing or invoking the getters.
    expect(prepareRetainedStepInput(value, workflowGlobal)).toEqual({
      retainable: false,
    });
    expect(vm.runInContext('globalThis.__retainedTestCalls', context)).toBe(0);
  });

  it('never inspects a proxied workflow constructor', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    const value = vm.runInContext(
      `(() => {
        const arr = [1];
        globalThis.__retainedTestCalls = 0;
        globalThis.Array = new Proxy(function Array() {}, {
          getOwnPropertyDescriptor(target, key) {
            globalThis.__retainedTestCalls++;
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
        return arr;
      })()`,
      context
    );

    expect(prepareRetainedStepInput(value, workflowGlobal)).toEqual({
      retainable: false,
    });
    expect(vm.runInContext('globalThis.__retainedTestCalls', context)).toBe(0);
  });
});

describe('host dispatch pristineness', () => {
  it('declines retention while a host dispatch constructor is spoofed', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    const value = vm.runInContext('({ plain: true })', context);

    expect(prepareRetainedStepInput(value, workflowGlobal).retainable).toBe(
      true
    );

    Object.defineProperty(Headers, Symbol.hasInstance, {
      value: () => false,
      configurable: true,
    });
    try {
      expect(prepareRetainedStepInput(value, workflowGlobal)).toEqual({
        retainable: false,
      });
    } finally {
      delete (Headers as any)[Symbol.hasInstance];
    }

    expect(prepareRetainedStepInput(value, workflowGlobal).retainable).toBe(
      true
    );
  });
});

describe('symbol-tagged inputs', () => {
  it('declines objects carrying symbol properties (serialization dispatch tags)', () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    const value = vm.runInContext(
      `(() => {
        const signal = { aborted: false };
        Object.defineProperty(signal, Symbol.for("WORKFLOW_ABORT_STREAM_NAME"), {
          value: "abort-stream",
          enumerable: false,
        });
        return { signal };
      })()`,
      context
    );

    expect(prepareRetainedStepInput(value, workflowGlobal)).toEqual({
      retainable: false,
    });
  });
});
