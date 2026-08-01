/**
 * Hardened serialization: serializing values built inside a workflow VM
 * must not execute workflow code, and must record the cases where it
 * cannot be avoided.
 *
 * Every fixture here is minted inside a real `node:vm` context via
 * `createContext()` — the same context the workflow runtime uses — and
 * serialized with the VM's `globalThis` as `options.global`, mirroring
 * `dehydrateStepArguments`.
 */

import { runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { dehydrateStepArguments } from '../serialization.js';
import { createContext } from '../vm/index.js';
import { devalueCodec } from './codec-devalue.js';
import type { GuestCodeStats } from './hardened.js';

const seed = 'hardened-serialization';
const fixedTimestamp = 1714857600000;

function makeVm() {
  const { context, globalThis: vmGlobalThis } = createContext({
    seed,
    fixedTimestamp,
  });
  // The real workflow VM injects these host classes (see workflow.ts).
  vmGlobalThis.Headers = globalThis.Headers;
  vmGlobalThis.Request = globalThis.Request;
  vmGlobalThis.Response = globalThis.Response;
  vmGlobalThis.ReadableStream = globalThis.ReadableStream;
  vmGlobalThis.WritableStream = globalThis.WritableStream;

  const decoder = new TextDecoder();

  return {
    context,
    vmGlobalThis,
    /** Evaluate an expression inside the VM. */
    evaluate: (source: string) => runInContext(`(${source})`, context),
    /** Run statements inside the VM. */
    run: (source: string) => runInContext(source, context),
    /**
     * Serialize a VM value the way the suspension handler does, returning
     * the wire string plus whatever guest code could not be avoided.
     */
    serialize: (value: unknown) => {
      const guestCodeStats: GuestCodeStats = { executions: [] };
      const bytes = devalueCodec.serialize(value, 'step', {
        global: vmGlobalThis,
        guestCodeStats,
      });
      return { wire: decoder.decode(bytes), stats: guestCodeStats };
    },
  };
}

describe('hardened serialization: patched prototypes are never executed', () => {
  it('serializes a Date without consulting the VM Date.prototype', () => {
    const vm = makeVm();
    vm.run(`
      globalThis.sideEffects = 0;
      const originalToISOString = Date.prototype.toISOString;
      const originalGetDate = Date.prototype.getDate;
      Date.prototype.toISOString = function () {
        globalThis.sideEffects++;
        return originalToISOString.call(this);
      };
      Date.prototype.getDate = function () {
        globalThis.sideEffects++;
        return originalGetDate.call(this);
      };
    `);

    const date = vm.evaluate('new Date(1700000000000)');
    const { wire, stats } = vm.serialize(date);

    expect(wire).toContain('2023-11-14T22:13:20.000Z');
    expect(vm.evaluate('globalThis.sideEffects')).toBe(0);
    expect(stats.executions).toEqual([]);
  });

  it('serializes Map/Set without consulting a patched Symbol.iterator', () => {
    const vm = makeVm();
    vm.run(`
      globalThis.sideEffects = 0;
      const patch = (proto) => {
        const original = proto[Symbol.iterator];
        proto[Symbol.iterator] = function () {
          globalThis.sideEffects++;
          return original.call(this);
        };
      };
      patch(Map.prototype);
      patch(Set.prototype);
      Map.prototype.entries = function () { globalThis.sideEffects++; throw new Error('nope'); };
      Set.prototype.values = function () { globalThis.sideEffects++; throw new Error('nope'); };
    `);

    const value = vm.evaluate(
      '({ map: new Map([["k", "v"]]), set: new Set([1, 2]) })'
    );
    const { wire, stats } = vm.serialize(value);

    expect(wire).toContain('Map');
    expect(wire).toContain('Set');
    expect(vm.evaluate('globalThis.sideEffects')).toBe(0);
    expect(stats.executions).toEqual([]);
  });

  it('serializes a RegExp without consulting patched source/flags getters', () => {
    const vm = makeVm();
    vm.run(`
      globalThis.sideEffects = 0;
      Object.defineProperty(RegExp.prototype, 'source', {
        configurable: true,
        get() { globalThis.sideEffects++; return 'hacked'; },
      });
      Object.defineProperty(RegExp.prototype, 'flags', {
        configurable: true,
        get() { globalThis.sideEffects++; return 'hacked'; },
      });
    `);

    const { wire, stats } = vm.serialize(vm.evaluate('/ab+c/gi'));

    expect(wire).toContain('ab+c');
    expect(wire).not.toContain('hacked');
    expect(vm.evaluate('globalThis.sideEffects')).toBe(0);
    expect(stats.executions).toEqual([]);
  });

  it('serializes typed arrays from internal slots, ignoring shadowed metadata', () => {
    const vm = makeVm();
    const view = vm.evaluate(`(() => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      // shadow the view metadata: a naive reader would hash the wrong range
      Object.defineProperty(bytes, 'byteLength', { value: 0 });
      Object.defineProperty(bytes, 'byteOffset', { value: 2 });
      return bytes;
    })()`);

    const { wire, stats } = vm.serialize(view);
    const expected = devalueCodec.serialize(
      new Uint8Array([1, 2, 3, 4]),
      'step'
    );

    expect(wire).toBe(new TextDecoder().decode(expected));
    expect(stats.executions).toEqual([]);
  });

  it('is not fooled by a Symbol.toStringTag spoof', () => {
    const vm = makeVm();
    // Object.prototype.toString would report [object Date] for this
    const spoofed = vm.evaluate(
      'Object.defineProperty({ a: 1 }, Symbol.toStringTag, { value: "Date" })'
    );

    const { wire } = vm.serialize(spoofed);

    // Classified by engine brand, so it serializes as the plain object it
    // is. (Unhardened devalue honours the tag and crashes calling
    // `toISOString()` on it — hardening is strictly better here.)
    expect(wire).toBe(
      new TextDecoder().decode(devalueCodec.serialize({ a: 1 }, 'step'))
    );
  });

  it('does not consult a patched Object.prototype.toString', () => {
    const vm = makeVm();
    vm.run(`
      globalThis.sideEffects = 0;
      Object.prototype.toString = function () {
        globalThis.sideEffects++;
        return '[object Date]';
      };
    `);

    const { wire } = vm.serialize(vm.evaluate('({ nested: { a: 1 } })'));

    expect(wire).toContain('nested');
    expect(vm.evaluate('globalThis.sideEffects')).toBe(0);
  });

  it('serializes URL/URLSearchParams without consulting patched accessors', () => {
    const vm = makeVm();
    // `URL`/`URLSearchParams` are host classes injected into the sandbox, so
    // patching their prototypes from inside the VM mutates the *host*
    // prototype for the rest of this worker process. Restore both, or every
    // later test in the file inherits the patch.
    const originalHref = Object.getOwnPropertyDescriptor(
      URL.prototype,
      'href'
    ) as PropertyDescriptor;
    const originalParamsToString = URLSearchParams.prototype.toString;
    try {
      vm.run(`
        globalThis.sideEffects = 0;
        Object.defineProperty(URL.prototype, 'href', {
          configurable: true,
          get() { globalThis.sideEffects++; return 'https://hacked.example/'; },
        });
        URLSearchParams.prototype.toString = function () {
          globalThis.sideEffects++;
          return 'hacked=1';
        };
      `);

      const value = vm.evaluate(
        '({ url: new URL("https://example.com/x?y=1"), params: new URLSearchParams("a=1") })'
      );
      const { wire, stats } = vm.serialize(value);

      expect(wire).toContain('https://example.com/x?y=1');
      expect(wire).toContain('a=1');
      expect(wire).not.toContain('hacked');
      expect(vm.evaluate('globalThis.sideEffects')).toBe(0);
      expect(stats.executions).toEqual([]);

      // Only now confirm the patch really did reach the host prototype —
      // reading `.href` here invokes it, so it has to come after the
      // side-effect assertion above.
      expect(new URL('https://example.com/').href).toBe(
        'https://hacked.example/'
      );
    } finally {
      Object.defineProperty(URL.prototype, 'href', originalHref);
      URLSearchParams.prototype.toString = originalParamsToString;
    }
  });

  it('serializes errors without consulting patched Error.prototype accessors', () => {
    const vm = makeVm();
    vm.run(`
      globalThis.sideEffects = 0;
      Object.defineProperty(Error.prototype, 'message', {
        configurable: true,
        get() { globalThis.sideEffects++; return 'hacked'; },
      });
    `);

    // own `message` data property (as `new Error(...)` produces) wins
    const error = vm.evaluate('new TypeError("boom")');
    const { wire, stats } = vm.serialize(error);

    expect(wire).toContain('boom');
    expect(wire).not.toContain('hacked');
    expect(vm.evaluate('globalThis.sideEffects')).toBe(0);
    expect(stats.executions).toEqual([]);
  });
});

describe('hardened serialization: unavoidable guest code is recorded', () => {
  it('records getter invocations and still serializes the value', () => {
    const vm = makeVm();
    const value = vm.evaluate(`(() => {
      globalThis.getterRuns = 0;
      return {
        plain: 'data',
        get computed() { globalThis.getterRuns++; return 'from getter'; },
      };
    })()`);

    const { wire, stats } = vm.serialize(value);

    // compatibility preserved: the getter still ran, the data is present
    expect(wire).toContain('from getter');
    expect(vm.evaluate('globalThis.getterRuns')).toBe(1);
    expect(stats.executions).toEqual([{ kind: 'getter', detail: 'computed' }]);
  });

  it('still identifies a proxied host class, and reports the traps', async () => {
    // Next.js hands the runtime a proxied `NextRequest`. `instanceof`
    // forwards through the `getPrototypeOf` trap, and the Request reducer
    // reads ordinary properties, so such values serialized fine before
    // hardening — answering "not a Request" for one silently broke every
    // webhook. Identification has to stay correct; the traps get reported.
    // No body: a request body is a ReadableStream, which the workflow-context
    // reducers expect to be a named handle. The proxy identification is what
    // this test is about; the full webhook path is covered end to end.
    const target = new Request('https://example.com/hook', { method: 'POST' });
    // Mirror how Next.js proxies a Request: the `get` trap forwards with the
    // *target* as receiver, so the built-in's private-slot reads still work.
    // (A bare `new Proxy(request, {})` throws on those reads — before this
    // change as well as after.)
    const proxied = new Proxy(target, {
      get(t, key) {
        const v = Reflect.get(t, key, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });

    const stats: GuestCodeStats = { executions: [] };
    const bytes = (await dehydrateStepArguments(
      proxied,
      'wrun_proxy',
      undefined,
      globalThis,
      false,
      false,
      stats
    )) as Uint8Array;
    const wire = new TextDecoder().decode(bytes);

    // serialized as a Request, not rejected as an arbitrary non-POJO
    expect(wire).toContain('Request');
    expect(wire).toContain('https://example.com/hook');
    // ...and the traps that ran are on the record
    expect(stats.executions.some((e) => e.kind === 'proxy')).toBe(true);
  });

  it('records a proxy once, not once per trap', () => {
    const vm = makeVm();
    const value = vm.evaluate(`(() => {
      globalThis.trapRuns = 0;
      const target = { a: 1, b: 2 };
      return {
        wrapped: new Proxy(target, {
          get(t, k) { globalThis.trapRuns++; return t[k]; },
          ownKeys(t) { globalThis.trapRuns++; return Reflect.ownKeys(t); },
          getOwnPropertyDescriptor(t, k) {
            globalThis.trapRuns++;
            return Reflect.getOwnPropertyDescriptor(t, k);
          },
        }),
      };
    })()`);

    const { wire, stats } = vm.serialize(value);

    expect(wire).toContain('"a"');
    const proxyReports = stats.executions.filter((e) => e.kind === 'proxy');
    expect(proxyReports).toHaveLength(1);
  });

  it('records custom WORKFLOW_SERIALIZE invocations', async () => {
    const { WORKFLOW_SERIALIZE } = await import('@workflow/serde');
    class Point {
      static classId = 'test/Point';
      static [WORKFLOW_SERIALIZE](p: Point) {
        return { x: p.x, y: p.y };
      }
      constructor(
        public x: number,
        public y: number
      ) {}
    }

    const guestCodeStats: GuestCodeStats = { executions: [] };
    devalueCodec.serialize(new Point(1, 2), 'step', { guestCodeStats });

    expect(guestCodeStats.executions).toEqual([
      { kind: 'method', detail: '[WORKFLOW_SERIALIZE] (test/Point)' },
    ]);
  });

  it('reports nothing for values that serialize side-effect free', () => {
    const vm = makeVm();
    const value = vm.evaluate(`({
      string: 'text',
      number: 42,
      bigint: 123n,
      bool: true,
      nil: null,
      nested: { deep: [1, 2, { three: 3 }] },
      when: new Date(1700000000000),
      pattern: /x/g,
      map: new Map([['k', 'v']]),
      set: new Set([1]),
      bytes: new Uint8Array([1, 2, 3]),
      buffer: new ArrayBuffer(4),
      url: new URL('https://example.com/'),
      error: new Error('boom'),
      sparse: [1, , 3],
    })`);

    const { stats } = vm.serialize(value);

    expect(stats.executions).toEqual([]);
  });
});

describe('hardened serialization: wire-format parity', () => {
  // Values built in the VM must serialize byte-identically to the same
  // values built on the host — hardening changes how we read, not what we
  // produce.
  const cases: Array<[string, string, unknown]> = [
    ['date', 'new Date(1700000000000)', new Date(1700000000000)],
    ['invalid date', 'new Date(NaN)', new Date(NaN)],
    ['regexp', '/ab+c/gi', /ab+c/gi],
    ['regexp without flags', '/plain/', /plain/],
    [
      'map',
      'new Map([["k", 1], ["j", 2]])',
      new Map<any, any>([
        ['k', 1],
        ['j', 2],
      ]),
    ],
    ['set', 'new Set([1, "two"])', new Set([1, 'two'])],
    ['empty map', 'new Map()', new Map()],
    [
      'url',
      'new URL("https://example.com/a?b=1")',
      new URL('https://example.com/a?b=1'),
    ],
    [
      'url search params',
      'new URLSearchParams("a=1&b=2")',
      new URLSearchParams('a=1&b=2'),
    ],
    ['empty url search params', 'new URLSearchParams()', new URLSearchParams()],
    ['uint8array', 'new Uint8Array([1, 2, 255])', new Uint8Array([1, 2, 255])],
    ['empty uint8array', 'new Uint8Array(0)', new Uint8Array(0)],
    ['int16array', 'new Int16Array([-1, 0, 1])', new Int16Array([-1, 0, 1])],
    ['float64array', 'new Float64Array([1.5])', new Float64Array([1.5])],
    [
      'bigint64array',
      'new BigInt64Array([1n, -2n])',
      new BigInt64Array([1n, -2n]),
    ],
    [
      'arraybuffer',
      'new Uint8Array([1, 2, 3]).buffer',
      new Uint8Array([1, 2, 3]).buffer,
    ],
    ['bigint', '123n', 123n],
    ['negative bigint', '-7n', -7n],
    ['plain object', '({ a: 1, b: "two" })', { a: 1, b: 'two' }],
    ['array', '[1, "two", null]', [1, 'two', null]],
    // biome-ignore lint/suspicious/noSparseArray: the hole is the fixture
    ['sparse array', '[1, , 3]', [1, , 3]],
    ['nested', '({ a: { b: [{ c: 1 }] } })', { a: { b: [{ c: 1 }] } }],
    ['-0', '-0', -0],
    ['NaN', 'NaN', NaN],
    ['Infinity', 'Infinity', Infinity],
    ['undefined', 'undefined', undefined],
    // DataView — exercises the three dataView* intrinsic captures
    [
      'dataview',
      'new DataView(new Uint8Array([1,2,3,4,5,6,7,8]).buffer, 1, 4)',
      new DataView(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, 1, 4),
    ],
    [
      'dataview whole buffer',
      'new DataView(new Uint8Array([1,2,3,4]).buffer)',
      new DataView(new Uint8Array([1, 2, 3, 4]).buffer),
    ],
    // boxed primitives — exercises unbox()'s three valueOf captures
    ['boxed number', 'new Number(42)', new Number(42)],
    ['boxed string', 'new String("boxed")', new String('boxed')],
    ['boxed boolean', 'new Boolean(true)', new Boolean(true)],
    // null-prototype objects, with and without data
    [
      'null-proto object',
      'Object.assign(Object.create(null), { x: 1, y: "two" })',
      Object.assign(Object.create(null), { x: 1, y: 'two' }),
    ],
    ['empty null-proto object', 'Object.create(null)', Object.create(null)],
    // a setter-only property reads as undefined (the `return undefined`
    // branch in readProperty), same as an unhardened `thing[key]`
    [
      'setter-only property',
      '(() => { const o = { a: 1 }; Object.defineProperty(o, "writeOnly", { set() {}, enumerable: true, configurable: true }); return o; })()',
      (() => {
        const o: Record<string, unknown> = { a: 1 };
        Object.defineProperty(o, 'writeOnly', {
          set() {},
          enumerable: true,
          configurable: true,
        });
        return o;
      })(),
    ],
  ];

  it.each(
    cases
  )('%s matches host serialization', (_label, source, hostValue) => {
    const vm = makeVm();
    const decoder = new TextDecoder();

    const fromVm = vm.serialize(vm.evaluate(source));
    const fromHost = decoder.decode(devalueCodec.serialize(hostValue, 'step'));

    expect(fromVm.wire).toBe(fromHost);
    expect(fromVm.stats.executions).toEqual([]);
  });

  it('round-trips a Headers instance built in the VM', () => {
    const vm = makeVm();
    const headers = vm.evaluate('new Headers({ "x-a": "1" })');
    const { wire, stats } = vm.serialize(headers);

    expect(wire).toContain('Headers');
    expect(wire).toContain('x-a');
    expect(stats.executions).toEqual([]);

    const revived = devalueCodec.deserialize(
      new TextEncoder().encode(wire),
      'step',
      { global: vm.vmGlobalThis }
    ) as Headers;
    expect(revived.get('x-a')).toBe('1');
  });

  // Error payloads carry realm-specific stack text (devalue stores the frames
  // as separate string elements), so these assert a structural round trip
  // rather than byte parity.
  it('round-trips a DOMException built in the VM', () => {
    const vm = makeVm();
    vm.vmGlobalThis.DOMException = globalThis.DOMException;
    const { wire, stats } = vm.serialize(
      vm.evaluate('new DOMException("nope", "AbortError")')
    );

    expect(wire).toContain('DOMException');
    expect(stats.executions).toEqual([]);

    const revived = devalueCodec.deserialize(
      new TextEncoder().encode(wire),
      'step',
      { global: vm.vmGlobalThis }
    ) as DOMException;
    expect(revived.name).toBe('AbortError');
    expect(revived.message).toBe('nope');
  });

  it('round-trips an AggregateError built in the VM', () => {
    const vm = makeVm();
    const { wire, stats } = vm.serialize(
      vm.evaluate(
        'new AggregateError([new Error("a"), new Error("b")], "many")'
      )
    );

    expect(wire).toContain('AggregateError');
    expect(stats.executions).toEqual([]);

    const revived = devalueCodec.deserialize(
      new TextEncoder().encode(wire),
      'step',
      { global: vm.vmGlobalThis }
    ) as AggregateError;
    expect(revived.message).toBe('many');
    expect(revived.errors.map((e: Error) => e.message)).toEqual(['a', 'b']);
  });

  it('round-trips a class instance through WORKFLOW_SERIALIZE, and reports it', async () => {
    const { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } = await import(
      '@workflow/serde'
    );
    const { registerSerializationClass } = await import(
      '../class-serialization.js'
    );

    class Point {
      static classId = 'test/hardened-Point';
      static [WORKFLOW_SERIALIZE](p: Point) {
        return { x: p.x, y: p.y };
      }
      static [WORKFLOW_DESERIALIZE](data: { x: number; y: number }) {
        return new Point(data.x, data.y);
      }
      constructor(
        public x: number,
        public y: number
      ) {}
    }
    registerSerializationClass('test/hardened-Point', Point);

    const stats: GuestCodeStats = { executions: [] };
    const bytes = devalueCodec.serialize(new Point(1, 2), 'step', {
      guestCodeStats: stats,
    });
    const wire = new TextDecoder().decode(bytes);

    // The custom serializer is workflow code by definition, so it is reported
    expect(stats.executions).toEqual([
      { kind: 'method', detail: '[WORKFLOW_SERIALIZE] (test/hardened-Point)' },
    ]);

    const revived = devalueCodec.deserialize(bytes, 'step') as Point;
    expect(revived).toBeInstanceOf(Point);
    expect([revived.x, revived.y]).toEqual([1, 2]);
    expect(wire).toContain('test/hardened-Point');
  });

  it('reports the RetryableError duck-typed retryAfter path', async () => {
    const vm = makeVm();
    // A date-like object with a `getTime()` method — invoking it is workflow
    // code, and the reducer says so.
    const error = vm.evaluate(`(() => {
      const e = new Error('later');
      e.name = 'RetryableError';
      e.retryAfter = { getTime: () => 1700000000000 };
      return e;
    })()`);

    const { wire, stats } = vm.serialize(error);

    expect(wire).toContain('RetryableError');
    expect(wire).toContain('1700000000000');
    expect(stats.executions).toEqual([{ kind: 'method', detail: 'getTime' }]);
  });

  it('reads a real Date retryAfter without reporting anything', () => {
    const vm = makeVm();
    const error = vm.evaluate(`(() => {
      const e = new Error('later');
      e.name = 'RetryableError';
      e.retryAfter = new Date(1700000000000);
      return e;
    })()`);

    const { wire, stats } = vm.serialize(error);

    expect(wire).toContain('1700000000000');
    expect(stats.executions).toEqual([]);
  });

  it('reports an accessor-valued Symbol.toStringTag', () => {
    const vm = makeVm();
    const value = vm.evaluate(`(() => {
      globalThis.tagReads = 0;
      const o = { a: 1 };
      Object.defineProperty(o, Symbol.toStringTag, {
        configurable: true,
        get() { globalThis.tagReads++; return 'CustomTag'; },
      });
      return o;
    })()`);

    const { wire, stats } = vm.serialize(value);

    // The tag is not brand-decided, so it is honoured — and reading it
    // through the accessor is reported.
    expect(vm.evaluate('globalThis.tagReads')).toBe(1);
    expect(stats.executions).toEqual([
      { kind: 'getter', detail: 'Symbol(Symbol.toStringTag)' },
    ]);
    expect(wire).toContain('"a"');
  });

  it('preserves shared references and cycles', () => {
    const vm = makeVm();
    const cyclic = vm.evaluate(
      '(() => { const o = { name: "cycle" }; o.self = o; return { first: o, second: o }; })()'
    );

    const { wire, stats } = vm.serialize(cyclic);
    expect(stats.executions).toEqual([]);

    const revived = devalueCodec.deserialize(
      new TextEncoder().encode(wire),
      'step',
      { global: vm.vmGlobalThis }
    ) as any;
    expect(revived.first).toBe(revived.second);
    expect(revived.first.self).toBe(revived.first);
  });
});

describe('hardened serialization: the real step-argument reducer set', () => {
  // `serialize()` above mirrors `dehydrateStepArguments` minus its
  // `extraReducers` — which is where the stream/request/abort guards live.
  // Those guards run on every value the earlier reducers do not claim, so
  // report completeness has to hold with them installed.
  // The real dehydrate path, including its stream/request/abort reducers,
  // with the report collected through the new out-param.
  async function serializeLikeDehydrate(
    vm: ReturnType<typeof makeVm>,
    value: unknown
  ) {
    const stats: GuestCodeStats = { executions: [] };
    const bytes = (await dehydrateStepArguments(
      value,
      'wrun_hardened',
      undefined,
      vm.vmGlobalThis,
      false,
      false,
      stats
    )) as Uint8Array;
    return { wire: new TextDecoder().decode(bytes), stats };
  }

  it('does not consult Symbol.hasInstance on the sandbox stream classes', async () => {
    const vm = makeVm();
    vm.run(`
      globalThis.hasInstanceRuns = 0;
      for (const ctor of [ReadableStream, WritableStream, Request, Response]) {
        Object.defineProperty(ctor, Symbol.hasInstance, {
          configurable: true,
          value() { globalThis.hasInstanceRuns++; return false; },
        });
      }
    `);

    const { wire } = await serializeLikeDehydrate(
      vm,
      vm.evaluate('({ a: 1, nested: { b: [2, 3] }, when: new Date(0) })')
    );

    expect(wire).toContain('nested');
    expect(vm.evaluate('globalThis.hasInstanceRuns')).toBe(0);
  });

  it('reports a non-enumerable `signal` getter instead of running it silently', async () => {
    const vm = makeVm();
    // `Object.keys` never reaches a non-enumerable property, so the plain
    // object walk does not read it — only the AbortController guard does.
    const value = vm.evaluate(`(() => {
      globalThis.signalReads = 0;
      const o = { plain: 1 };
      Object.defineProperty(o, 'signal', {
        enumerable: false,
        configurable: true,
        get() { globalThis.signalReads++; return undefined; },
      });
      return o;
    })()`);

    const { stats } = await serializeLikeDehydrate(vm, value);

    const reads = vm.evaluate('globalThis.signalReads') as number;
    // Either the guard never touched it, or it did and said so — the thing
    // that must not happen is an invocation with an empty report.
    expect(reads === 0 || stats.executions.length > 0).toBe(true);
    if (reads > 0) {
      expect(stats.executions).toContainEqual({
        kind: 'getter',
        detail: 'signal',
      });
    }
  });

  it('still reports nothing for an ordinary payload', async () => {
    const vm = makeVm();
    const { stats } = await serializeLikeDehydrate(
      vm,
      vm.evaluate(
        '({ list: [1, 2], when: new Date(1700000000000), map: new Map([["k","v"]]) })'
      )
    );
    expect(stats.executions).toEqual([]);
  });
});

describe('hardened serialization: cross-realm classification', () => {
  // Reassigning a sandbox global used to break `instanceof global.X`
  // classification; brand checks are immune.
  it('classifies values whose VM global was reassigned', () => {
    const vm = makeVm();
    const value = vm.evaluate(`(() => {
      const real = { date: new Date(1700000000000), map: new Map([["k", "v"]]) };
      globalThis.Date = function FakeDate() {};
      globalThis.Map = function FakeMap() {};
      return real;
    })()`);

    const { wire, stats } = vm.serialize(value);

    expect(wire).toContain('2023-11-14T22:13:20.000Z');
    expect(wire).toContain('Map');
    expect(stats.executions).toEqual([]);
  });

  it('classifies values with a hostile Symbol.hasInstance', () => {
    const vm = makeVm();
    const value = vm.evaluate(`(() => {
      globalThis.hasInstanceRuns = 0;
      Object.defineProperty(globalThis.Date, Symbol.hasInstance, {
        configurable: true,
        value() { globalThis.hasInstanceRuns++; return true; },
      });
      return { plain: { a: 1 } };
    })()`);

    const { wire } = vm.serialize(value);

    // the plain object is not misclassified as a Date, and hasInstance
    // was never consulted
    expect(wire).toBe('[{"plain":1},{"a":2},1]');
    expect(vm.evaluate('globalThis.hasInstanceRuns')).toBe(0);
  });
});
