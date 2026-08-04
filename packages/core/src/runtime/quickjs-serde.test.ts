/**
 * Wire-format parity tests for the host-side QuickJS serde.
 *
 * Every case round-trips a value three ways and cross-checks against the
 * host reference codec (`serialization/workflow-vm.ts` — the exact codec
 * the retired in-VM serde bundle was built from):
 *
 *   1. guest value ──host serde serialize──▶ bytes, byte-compared with the
 *      reference codec serializing the equivalent host value;
 *   2. reference-codec bytes ──host serde deserialize──▶ guest value,
 *      verified from inside the VM;
 *   3. host serde bytes ──host serde deserialize──▶ guest value (full
 *      round trip through the new implementation only).
 *
 * Event logs persist across SDK versions, so these equivalences are what
 * keeps old runs replayable by the new runtime (and runs started by the
 * new runtime readable by node-engine steps and observability).
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { QuickJS } from 'quickjs-wasi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deserialize as referenceDeserialize,
  serialize as referenceSerialize,
} from '../serialization/workflow-vm.js';
import { createQuickJSSerde, type QuickJSSerde } from './quickjs-serde.js';

const require = createRequire(import.meta.url);

let vm: QuickJS;
let serde: QuickJSSerde;

beforeAll(async () => {
  const wasm = fs.readFileSync(require.resolve('quickjs-wasi/quickjs.wasm'));
  vm = await QuickJS.create({ wasm });
  serde = createQuickJSSerde(vm);
});

afterAll(() => {
  serde.dispose();
  vm.dispose();
});

/** Serialize the guest value produced by evaluating `expr` in the VM. */
function serializeGuest(expr: string): Uint8Array {
  const handle = vm.evalCode(`(${expr})`);
  try {
    return serde.serialize(handle);
  } finally {
    handle.dispose();
  }
}

/** Run `checkFnSource` (guest fn of one arg) against a deserialized value. */
function checkInGuest(bytes: Uint8Array, checkFnSource: string): unknown {
  const value = serde.deserialize(bytes);
  const checker = vm.evalCode(`(${checkFnSource})`);
  try {
    const result = vm.callFunction(checker, vm.undefined, value);
    const dumped = vm.dump(result);
    result.dispose();
    return dumped;
  } finally {
    checker.dispose();
    value.dispose();
  }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('wire parity: guest serialize matches the reference codec', () => {
  const cases: [name: string, guestExpr: string, hostValue: () => unknown][] = [
    ['undefined', 'undefined', () => undefined],
    ['null', 'null', () => null],
    ['number', '42.5', () => 42.5],
    ['negative zero', '-0', () => -0],
    ['NaN', 'NaN', () => Number.NaN],
    ['Infinity', 'Infinity', () => Number.POSITIVE_INFINITY],
    ['string', '"hello \\u2028 world"', () => 'hello \u2028 world'],
    ['boolean', 'true', () => true],
    [
      'bigint',
      '123456789012345678901234567890n',
      () => 123456789012345678901234567890n,
    ],
    [
      'plain object',
      '({a: 1, b: "two", c: null})',
      () => ({ a: 1, b: 'two', c: null }),
    ],
    ['nested arrays', '[1, [2, [3, [4]]]]', () => [1, [2, [3, [4]]]]],
    [
      'sparse array',
      '(() => { const a = [1]; a[3] = 4; return a; })()',
      () => {
        const a: unknown[] = [1];
        a[3] = 4;
        return a;
      },
    ],
    ['Date', 'new Date(1700000000000)', () => new Date(1700000000000)],
    ['invalid Date', 'new Date(NaN)', () => new Date(Number.NaN)],
    ['RegExp', '/ab+c/gi', () => /ab+c/gi],
    [
      'Map',
      'new Map([["k1", 1], ["k2", {nested: true}]])',
      () =>
        new Map<string, unknown>([
          ['k1', 1],
          ['k2', { nested: true }],
        ]),
    ],
    ['Set', 'new Set([1, "two", null])', () => new Set([1, 'two', null])],
    [
      'Uint8Array',
      'new Uint8Array([1, 2, 3, 255])',
      () => new Uint8Array([1, 2, 3, 255]),
    ],
    ['empty Uint8Array', 'new Uint8Array(0)', () => new Uint8Array(0)],
    [
      'Int32Array',
      'new Int32Array([-1, 2147483647])',
      () => new Int32Array([-1, 2147483647]),
    ],
    [
      'Float64Array',
      'new Float64Array([1.5, -2.25])',
      () => new Float64Array([1.5, -2.25]),
    ],
    [
      'BigInt64Array',
      'new BigInt64Array([1n, -2n])',
      () => new BigInt64Array([1n, -2n]),
    ],
    [
      'ArrayBuffer',
      'new Uint8Array([9, 8, 7]).buffer',
      () => new Uint8Array([9, 8, 7]).buffer,
    ],
    [
      'subarray view',
      'new Uint8Array([1,2,3,4,5]).subarray(1, 4)',
      () => new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 4),
    ],
    [
      'Error',
      '(() => { const e = new Error("boom"); e.stack = "fake-stack"; return e; })()',
      () => {
        const e = new Error('boom');
        e.stack = 'fake-stack';
        return e;
      },
    ],
    [
      'TypeError',
      '(() => { const e = new TypeError("bad type"); e.stack = "ts"; return e; })()',
      () => {
        const e = new TypeError('bad type');
        e.stack = 'ts';
        return e;
      },
    ],
    [
      'Error with cause',
      '(() => { const c = new Error("cause"); c.stack = "cs"; const e = new Error("outer", { cause: c }); e.stack = "os"; return e; })()',
      () => {
        const c = new Error('cause');
        c.stack = 'cs';
        const e = new Error('outer', { cause: c });
        e.stack = 'os';
        return e;
      },
    ],
    [
      'custom-named Error',
      '(() => { const e = new Error("custom"); e.name = "MyCustomError"; e.stack = "st"; return e; })()',
      () => {
        const e = new Error('custom');
        e.name = 'MyCustomError';
        e.stack = 'st';
        return e;
      },
    ],
    [
      'shared reference',
      '(() => { const shared = {x: 1}; return {a: shared, b: shared}; })()',
      () => {
        const shared = { x: 1 };
        return { a: shared, b: shared };
      },
    ],
    [
      'cycle',
      '(() => { const o = {}; o.self = o; return o; })()',
      () => {
        const o: Record<string, unknown> = {};
        o.self = o;
        return o;
      },
    ],
    [
      'null-prototype object',
      'Object.assign(Object.create(null), {k: "v"})',
      () => Object.assign(Object.create(null), { k: 'v' }),
    ],
    [
      'boxed primitives',
      '[new Number(5), new String("s"), new Boolean(false)]',
      () => [new Number(5), new String('s'), new Boolean(false)],
    ],
  ];

  for (const [name, guestExpr, hostValue] of cases) {
    it(name, () => {
      const guestBytes = serializeGuest(guestExpr);
      const referenceBytes = referenceSerialize(hostValue());
      expect(text(guestBytes)).toBe(text(referenceBytes));
    });
  }
});

describe('wire parity: reference-codec bytes revive correctly in the VM', () => {
  it('revives built-ins with working prototypes', () => {
    const bytes = referenceSerialize({
      when: new Date(1700000000000),
      pattern: /x\d+/g,
      entries: new Map([['a', 1]]),
      items: new Set(['b']),
      bytes: new Uint8Array([1, 2, 3]),
      big: 42n,
    });
    expect(
      checkInGuest(
        text(bytes) === '' ? bytes : bytes,
        `function (v) {
          return {
            isDate: v.when instanceof Date,
            time: v.when.getTime(),
            regExp: v.pattern instanceof RegExp && v.pattern.source === "x\\\\d+" && v.pattern.flags === "g",
            mapGet: v.entries instanceof Map && v.entries.get("a") === 1,
            setHas: v.items instanceof Set && v.items.has("b"),
            bytesOk: v.bytes instanceof Uint8Array && v.bytes.length === 3 && v.bytes[2] === 3,
            bigOk: typeof v.big === "bigint" && v.big === 42n,
          };
        }`
      )
    ).toEqual({
      isDate: true,
      time: 1700000000000,
      regExp: true,
      mapGet: true,
      setHas: true,
      bytesOk: true,
      bigOk: true,
    });
  });

  it('revives Error subclasses with instanceof identity and cause chain', () => {
    const cause = new RangeError('too big');
    cause.stack = 'cause-stack';
    const outer = new TypeError('bad', { cause });
    outer.stack = 'outer-stack';
    const bytes = referenceSerialize(outer);
    expect(
      checkInGuest(
        bytes,
        `function (e) {
          return {
            isTypeError: e instanceof TypeError,
            message: e.message,
            stack: e.stack,
            causeIsRangeError: e.cause instanceof RangeError,
            causeMessage: e.cause && e.cause.message,
          };
        }`
      )
    ).toEqual({
      isTypeError: true,
      message: 'bad',
      stack: 'outer-stack',
      causeIsRangeError: true,
      causeMessage: 'too big',
    });
  });

  it('revives shared references and cycles with identity intact', () => {
    const shared = { tag: 'shared' };
    const cyclic: Record<string, unknown> = { a: shared, b: shared };
    cyclic.self = cyclic;
    const bytes = referenceSerialize(cyclic);
    expect(
      checkInGuest(
        bytes,
        `function (v) {
          return { sameRef: v.a === v.b, cycle: v.self === v };
        }`
      )
    ).toEqual({ sameRef: true, cycle: true });
  });
});

describe('full round trip through the host serde only', () => {
  it('guest → bytes → guest preserves values and identity', () => {
    const bytes = serializeGuest(
      `(() => {
        const shared = new Map([["n", 1]]);
        return {
          shared1: shared,
          shared2: shared,
          date: new Date(1700000000000),
          list: [1, "two", new Set([3])],
        };
      })()`
    );
    expect(
      checkInGuest(
        bytes,
        `function (v) {
          return {
            sameRef: v.shared1 === v.shared2,
            mapVal: v.shared1.get("n"),
            time: v.date.getTime(),
            setHas: v.list[2].has(3),
          };
        }`
      )
    ).toEqual({ sameRef: true, mapVal: 1, time: 1700000000000, setHas: true });
  });
});

describe('NUL (U+0000) safety across the WASM boundary', () => {
  // `JS_ToCString` is NUL-terminated: naive extraction truncates guest
  // strings at the first U+0000 and mangles NUL-bearing property keys
  // (truncated keys either drop — the truncated name fails the
  // enumerability probe — or collide with a sibling key). These pin the
  // guestString length-check fallback and the shapeOf/get/hasOwn
  // handle-keyed paths. Regression: nullByteWorkflow failing on every
  // quickjs e2e leg.

  it('round-trips NUL-bearing string values (guest → bytes → guest)', () => {
    const bytes = serializeGuest(`(() => ({
      middle: "ab\u0000cd",
      leading: "\u0000x",
      trailing: "x\u0000",
      only: "\u0000",
      multi: "a\u0000b\u0000c",
    }))()`);
    expect(
      checkInGuest(
        bytes,
        `function (v) {
          return [
            v.middle === "ab\u0000cd",
            v.leading === "\u0000x",
            v.trailing === "x\u0000",
            v.only === "\u0000",
            v.multi === "a\u0000b\u0000c",
          ].every(Boolean);
        }`
      )
    ).toBe(true);
  });

  it('matches the reference codec byte-for-byte on NUL strings', () => {
    const guestBytes = serializeGuest(`("ab\u0000cd")`);
    const referenceBytes = referenceSerialize('ab cd');
    expect(Buffer.from(guestBytes).toString('utf8')).toBe(
      Buffer.from(referenceBytes).toString('utf8')
    );
  });

  it('round-trips NUL-bearing object keys, including the collision shape', () => {
    // "a\u0000b" truncates to "a" — with a REAL sibling "a" present the
    // truncated key collides instead of dropping, which is the harder
    // detection case for the enumeration fast path.
    const bytes = serializeGuest(`(() => ({
      "a\u0000b": "nul-key-value",
      a: "plain-key-value",
      normal: 1,
    }))()`);
    expect(
      checkInGuest(
        bytes,
        `function (v) {
          return {
            nulKey: v["a\u0000b"],
            plain: v.a,
            normal: v.normal,
            keyCount: Object.keys(v).length,
          };
        }`
      )
    ).toEqual({
      nulKey: 'nul-key-value',
      plain: 'plain-key-value',
      normal: 1,
      keyCount: 3,
    });
  });

  it('round-trips a NUL key that would otherwise silently drop', () => {
    const bytes = serializeGuest(`(() => ({ "k\u0000": 42 }))()`);
    expect(checkInGuest(bytes, `function (v) { return v["k\u0000"]; }`)).toBe(
      42
    );
  });

  it('deserializes reference-codec NUL keys into the guest correctly', () => {
    const referenceBytes = referenceSerialize({ 'x y': 'v' });
    expect(
      checkInGuest(referenceBytes, `function (v) { return v["x\u0000y"]; }`)
    ).toBe('v');
  });
});

describe('workflow-specific reducers', () => {
  it('step function proxies round-trip through StepFunction (with closure vars and bound this)', () => {
    // Minimal WORKFLOW_USE_STEP mirroring the runtime bootstrap's proxy shape.
    vm.evalCode(`
      globalThis[Symbol.for("WORKFLOW_USE_STEP")] = function (stepId, closureVarsFn) {
        var fn = function () { return "called:" + stepId; };
        fn.stepId = stepId;
        if (closureVarsFn) fn.__closureVarsFn = closureVarsFn;
        fn.bind = function (thisArg) {
          var partialArgs = Array.prototype.slice.call(arguments, 1);
          var bound = Function.prototype.bind.apply(this, [thisArg].concat(partialArgs));
          bound.stepId = stepId;
          if (closureVarsFn) bound.__closureVarsFn = closureVarsFn;
          bound.__boundThis = thisArg;
          if (partialArgs.length > 0) bound.__boundArgs = partialArgs;
          return bound;
        };
        return fn;
      };
    `).dispose();

    const bytes = serializeGuest(
      `globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//file//fn", function () { return { captured: 7 }; })`
    );
    // Wire parity with the reference codec's StepFunction reducer.
    const hostProxy = Object.assign(() => {}, {
      stepId: 'step//file//fn',
      __closureVarsFn: () => ({ captured: 7 }),
    });
    expect(text(bytes)).toBe(text(referenceSerialize(hostProxy)));

    expect(
      checkInGuest(
        bytes,
        `function (fn) {
          return {
            stepId: fn.stepId,
            captured: fn.__closureVarsFn().captured,
            callable: fn() === "called:step//file//fn",
          };
        }`
      )
    ).toEqual({ stepId: 'step//file//fn', captured: 7, callable: true });
  });

  it('workflow function references reduce to { workflowId }', () => {
    const bytes = serializeGuest(
      `Object.assign(function () {}, { workflowId: "workflow//file//wf" })`
    );
    const hostRef = Object.assign(() => {}, {
      workflowId: 'workflow//file//wf',
    });
    expect(text(bytes)).toBe(text(referenceSerialize(hostRef)));
    expect(checkInGuest(bytes, `function (f) { return f.workflowId; }`)).toBe(
      'workflow//file//wf'
    );
  });

  it('named stream handles round-trip via symbol-stamped properties', () => {
    vm.evalCode(`
      if (typeof globalThis.ReadableStream === "undefined") {
        globalThis.ReadableStream = function () {};
      }
      if (typeof globalThis.WritableStream === "undefined") {
        globalThis.WritableStream = function () {};
      }
    `).dispose();
    // The stream prototypes were not present at serde creation in this
    // test VM, so recreate the serde with them installed.
    serde.dispose();
    serde = createQuickJSSerde(vm);

    const bytes = serializeGuest(
      `(() => {
        const s = Object.create(globalThis.ReadableStream.prototype);
        s[Symbol.for("WORKFLOW_STREAM_NAME")] = "stream_123";
        s[Symbol.for("WORKFLOW_STREAM_TYPE")] = "bytes";
        s[Symbol.for("WORKFLOW_STREAM_FRAMING")] = "framed-v1";
        return s;
      })()`
    );
    expect(
      checkInGuest(
        bytes,
        `function (s) {
          return {
            name: s[Symbol.for("WORKFLOW_STREAM_NAME")],
            type: s[Symbol.for("WORKFLOW_STREAM_TYPE")],
            framing: s[Symbol.for("WORKFLOW_STREAM_FRAMING")],
            proto: Object.getPrototypeOf(s) === globalThis.ReadableStream.prototype,
          };
        }`
      )
    ).toEqual({
      name: 'stream_123',
      type: 'bytes',
      framing: 'framed-v1',
      proto: true,
    });
  });

  it('class instances with WORKFLOW_SERIALIZE round-trip through the registry', () => {
    vm.evalCode(`
      (function () {
        var registry = globalThis[Symbol.for("workflow-class-registry")];
        if (!registry) {
          registry = new Map();
          globalThis[Symbol.for("workflow-class-registry")] = registry;
        }
        function Point(x, y) { this.x = x; this.y = y; }
        Point.classId = "class//test//Point";
        Point[Symbol.for("workflow-serialize")] = function (p) { return [p.x, p.y]; };
        Point[Symbol.for("workflow-deserialize")] = function (data) { return new Point(data[0], data[1]); };
        registry.set("class//test//Point", Point);
        globalThis.__TestPoint = Point;
      })();
    `).dispose();

    const bytes = serializeGuest(`new globalThis.__TestPoint(3, 4)`);
    expect(text(bytes)).toContain('"Instance"');
    expect(text(bytes)).toContain('class//test//Point');
    expect(
      checkInGuest(
        bytes,
        `function (p) {
          return { x: p.x, y: p.y, isPoint: p instanceof globalThis.__TestPoint };
        }`
      )
    ).toEqual({ x: 3, y: 4, isPoint: true });
  });
});

describe('side-effect freedom', () => {
  it('serializing does not execute patched prototype methods', () => {
    vm.evalCode(`
      globalThis.__spyCalls = 0;
      const originalToISOString = Date.prototype.toISOString;
      Date.prototype.toISOString = function () { globalThis.__spyCalls++; return originalToISOString.call(this); };
      const originalGetTime = Date.prototype.getTime;
      Date.prototype.getTime = function () { globalThis.__spyCalls++; return originalGetTime.call(this); };
      const originalForEach = Map.prototype.forEach;
      Map.prototype.forEach = function () { globalThis.__spyCalls++; return originalForEach.apply(this, arguments); };
      Map.prototype[Symbol.iterator] = function () { globalThis.__spyCalls++; throw new Error("iterator should not run"); };
    `).dispose();

    const bytes = serializeGuest(
      `({ when: new Date(1700000000000), entries: new Map([["k", 1]]) })`
    );
    const spyCalls = vm
      .evalCode('globalThis.__spyCalls')
      .consume((h) => h.toNumber());
    expect(spyCalls).toBe(0);
    // Output is still correct — captured intrinsics did the work.
    expect(text(bytes)).toBe(
      text(
        referenceSerialize({
          when: new Date(1700000000000),
          entries: new Map([['k', 1]]),
        })
      )
    );

    // Restore for other tests.
    vm.evalCode(`
      delete Map.prototype[Symbol.iterator];
    `).dispose();
  });

  it('a Symbol.toStringTag spoof does not reclassify a plain object', () => {
    // Classification is by engine brand (classId), so an object CLAIMING to
    // be a Date serializes as the plain object it actually is. The
    // unhardened reference codec crashes on this input (devalue's default
    // tagOf trusts Object.prototype.toString and routes it to the Date
    // extractor) — same strictly-better outcome as the node:vm hardened
    // codec.
    expect(() =>
      referenceSerialize({ [Symbol.toStringTag]: 'Date', value: 1 })
    ).toThrow();
    const bytes = serializeGuest(
      `(() => {
        const o = { value: 1 };
        Object.defineProperty(o, Symbol.toStringTag, {
          value: "Date",
          enumerable: false,
        });
        return o;
      })()`
    );
    expect(text(bytes)).toBe(text(referenceSerialize({ value: 1 })));
  });
});

describe('reducer/reviver exhaustiveness vs the shared value-space codec', () => {
  // A reducer/reviver added to codec-devalue-vm's workflow mode but not to
  // the handle-space serde would silently round-trip values of that type
  // as plain objects — this pins the two key sets to each other so the
  // next addition fails loudly here instead.
  it('reducer key sets match exactly (order included — first match wins)', async () => {
    const { getWorkflowModeReducerKeys } = await import(
      '../serialization/codec-devalue-vm.js'
    );
    expect([...serde.reducerKeys]).toEqual(getWorkflowModeReducerKeys());
  });

  it('reviver key sets match exactly', async () => {
    const { getWorkflowModeReviverKeys } = await import(
      '../serialization/codec-devalue-vm.js'
    );
    expect([...serde.reviverKeys].sort()).toEqual(
      getWorkflowModeReviverKeys().sort()
    );
  });
});
