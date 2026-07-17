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
      `(() => {
        const buffer = new ArrayBuffer(8);
        return {
          nested: [{ ok: true }],
          map: new Map([["key", new Set([1, 2])]]),
          bytes: new Uint8Array(buffer, 2, 4),
        };
      })()`,
      context
    );

    const prepared = prepareRetainedStepInput(value, workflowGlobal);

    expect(prepared.retainable).toBe(true);
    if (!prepared.retainable) return;
    expect(prepared.value).toEqual({
      nested: [{ ok: true }],
      map: new Map([['key', new Set([1, 2])]]),
      bytes: new Uint8Array(4),
    });
    expect(Object.getPrototypeOf(prepared.value)).toBe(Object.prototype);
  });

  it('produces the same serialized bytes as ordinary VM traversal', async () => {
    const { context, globalThis: workflowGlobal } = createContext({
      seed,
      fixedTimestamp,
    });
    const value = vm.runInContext(
      `({
        nested: [{ ok: true, missing: undefined }],
        map: new Map([["key", new Set([1, 2])]]),
        bytes: new Uint8Array([1, 2, 3, 4]),
        date: new Date(1234),
        regexp: /workflow/gi,
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
});
