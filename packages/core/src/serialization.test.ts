import { runInContext } from 'node:vm';
import type { WorkflowRuntimeError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import { getStepFunction, registerStepFunction } from './private.js';
import { registerSerializationClass } from './class-serialization.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  dehydrateWorkflowReturnValue,
  getCommonRevivers,
  getStreamType,
  getWorkflowReducers,
  hydrateStepArguments,
  hydrateWorkflowArguments,
} from './serialization.js';
import {
  STABLE_ULID,
  STREAM_NAME_SYMBOL,
  WORKFLOW_DESERIALIZE,
  WORKFLOW_SERIALIZE,
} from './symbols.js';
import { createContext } from './vm/index.js';

const mockRunId = 'wrun_mockidnumber0001';

describe('getStreamType', () => {
  it('should return `undefined` for a regular stream', () => {
    const stream = new ReadableStream();
    expect(stream.locked).toBe(false);
    expect(getStreamType(stream)).toBeUndefined();
    expect(stream.locked).toBe(false);
  });

  it('should return "bytes" for a byte stream', () => {
    const stream = new ReadableStream({
      type: 'bytes',
    });
    expect(stream.locked).toBe(false);
    expect(getStreamType(stream)).toBe('bytes');
    expect(stream.locked).toBe(false);
  });
});

describe('workflow arguments', () => {
  const { context, globalThis: vmGlobalThis } = createContext({
    seed: 'test',
    fixedTimestamp: 1714857600000,
  });

  it('should work with Date', () => {
    const date = new Date('2025-07-17T04:30:34.824Z');
    const serialized = dehydrateWorkflowArguments(date, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Date",
          1,
        ],
        "2025-07-17T04:30:34.824Z",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;

    expect(runInContext('val instanceof Date', context)).toBe(true);
    expect(hydrated.getTime()).toEqual(date.getTime());
  });

  it('should work with invalid Date', () => {
    const date = new Date('asdf');
    const serialized = dehydrateWorkflowArguments(date, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Date",
          1,
        ],
        ".",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;

    expect(runInContext('val instanceof Date', context)).toBe(true);
    expect(hydrated.getTime()).toEqual(NaN);
  });

  it('should work with BigInt', () => {
    const bigInt = BigInt('9007199254740992');
    const serialized = dehydrateWorkflowArguments(bigInt, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "BigInt",
          1,
        ],
        "9007199254740992",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    expect(hydrated).toBe(BigInt(9007199254740992));
    expect(typeof hydrated).toBe('bigint');
  });

  it('should work with BigInt negative', () => {
    const bigInt = BigInt('-12345678901234567890');
    const serialized = dehydrateWorkflowArguments(bigInt, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "BigInt",
          1,
        ],
        "-12345678901234567890",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    expect(hydrated).toBe(BigInt('-12345678901234567890'));
    expect(typeof hydrated).toBe('bigint');
  });

  it('should work with Map', () => {
    const map = new Map([
      [2, 'foo'],
      [6, 'bar'],
    ]);
    const serialized = dehydrateWorkflowArguments(map, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Map",
          1,
        ],
        [
          2,
          5,
        ],
        [
          3,
          4,
        ],
        2,
        "foo",
        [
          6,
          7,
        ],
        6,
        "bar",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;

    expect(runInContext('val instanceof Map', context)).toBe(true);
  });

  it('should work with Set', () => {
    const set = new Set([1, '2', true]);
    const serialized = dehydrateWorkflowArguments(set, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Set",
          1,
        ],
        [
          2,
          3,
          4,
        ],
        1,
        "2",
        true,
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;

    expect(runInContext('val instanceof Set', context)).toBe(true);
  });

  it('should work with WritableStream', () => {
    const stream = new WritableStream();
    const serialized = dehydrateWorkflowArguments(stream, [], mockRunId);
    const streamName = serialized[2] as string;
    expect(streamName).toMatch(/^strm_[0-9A-Z]{26}$/);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "WritableStream",
          1,
        ],
        {
          "name": 2,
        },
        "${streamName}",
      ]
    `);

    class OurWritableStream {}
    const hydrated = hydrateWorkflowArguments(serialized, {
      WritableStream: OurWritableStream,
    });
    expect(hydrated).toBeInstanceOf(OurWritableStream);
    expect(hydrated[STREAM_NAME_SYMBOL]).toEqual(streamName);
  });

  it('should work with ReadableStream', () => {
    const stream = new ReadableStream();
    const serialized = dehydrateWorkflowArguments(stream, [], mockRunId);
    const streamName = serialized[2] as string;
    expect(streamName).toMatch(/^strm_[0-9A-Z]{26}$/);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "ReadableStream",
          1,
        ],
        {
          "name": 2,
        },
        "${streamName}",
      ]
    `);

    class OurReadableStream {}
    const hydrated = hydrateWorkflowArguments(serialized, {
      ReadableStream: OurReadableStream,
    });
    expect(hydrated).toBeInstanceOf(OurReadableStream);
    expect(hydrated[STREAM_NAME_SYMBOL]).toEqual(streamName);
  });

  it('should work with Headers', () => {
    const headers = new Headers();
    headers.set('foo', 'bar');
    headers.append('set-cookie', 'a');
    headers.append('set-cookie', 'b');
    const serialized = dehydrateWorkflowArguments(headers, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Headers",
          1,
        ],
        [
          2,
          5,
          8,
        ],
        [
          3,
          4,
        ],
        "foo",
        "bar",
        [
          6,
          7,
        ],
        "set-cookie",
        "a",
        [
          6,
          9,
        ],
        "b",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    expect(hydrated).toBeInstanceOf(Headers);
    expect(hydrated.get('foo')).toEqual('bar');
    expect(hydrated.get('set-cookie')).toEqual('a, b');
  });

  it('should work with Response', () => {
    const response = new Response('Hello, world!', {
      status: 202,
      statusText: 'Custom',
      headers: new Headers([
        ['foo', 'bar'],
        ['set-cookie', 'a'],
        ['set-cookie', 'b'],
      ]),
    });
    const serialized = dehydrateWorkflowArguments(response, [], mockRunId);
    const bodyStreamName = serialized[serialized.length - 3] as string;
    expect(bodyStreamName).toMatch(/^strm_[0-9A-Z]{26}$/);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Response",
          1,
        ],
        {
          "body": 19,
          "headers": 6,
          "redirected": 23,
          "status": 4,
          "statusText": 5,
          "type": 2,
          "url": 3,
        },
        "default",
        "",
        202,
        "Custom",
        [
          "Headers",
          7,
        ],
        [
          8,
          11,
          14,
          17,
        ],
        [
          9,
          10,
        ],
        "content-type",
        "text/plain;charset=UTF-8",
        [
          12,
          13,
        ],
        "foo",
        "bar",
        [
          15,
          16,
        ],
        "set-cookie",
        "a",
        [
          15,
          18,
        ],
        "b",
        [
          "ReadableStream",
          20,
        ],
        {
          "name": 21,
          "type": 22,
        },
        "${bodyStreamName}",
        "bytes",
        false,
      ]
    `);

    class OurResponse {
      public headers;
      public body;
      constructor(body, init) {
        this.body = body || init.body;
        this.headers = init.headers;
      }
    }
    class OurReadableStream {}
    class OurHeaders {}
    const hydrated = hydrateWorkflowArguments(serialized, {
      Headers: OurHeaders,
      Response: OurResponse,
      ReadableStream: OurReadableStream,
    });
    expect(hydrated).toBeInstanceOf(OurResponse);
    expect(hydrated.headers).toBeInstanceOf(OurHeaders);
    expect(hydrated.body).toBeInstanceOf(OurReadableStream);
  });

  it('should work with URLSearchParams', () => {
    const params = new URLSearchParams('a=1&b=2&a=3');

    const serialized = dehydrateWorkflowArguments(params, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "URLSearchParams",
          1,
        ],
        "a=1&b=2&a=3",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof URLSearchParams', context)).toBe(true);
    expect(hydrated.getAll('a')).toEqual(['1', '3']);
    expect(hydrated.getAll('b')).toEqual(['2']);
    expect(hydrated.toString()).toEqual('a=1&b=2&a=3');
    expect(Array.from(hydrated.entries())).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['a', '3'],
    ]);
  });

  it('should work with empty URLSearchParams', () => {
    const params = new URLSearchParams();

    const serialized = dehydrateWorkflowArguments(params, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "URLSearchParams",
          1,
        ],
        ".",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof URLSearchParams', context)).toBe(true);
    expect(hydrated.toString()).toEqual('');
    expect(Array.from(hydrated.entries())).toEqual([]);
  });

  it('should work with empty ArrayBuffer', () => {
    const buffer = new ArrayBuffer(0);

    const serialized = dehydrateWorkflowArguments(buffer, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "ArrayBuffer",
          1,
        ],
        ".",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof ArrayBuffer', context)).toBe(true);
    expect(hydrated.byteLength).toEqual(0);
  });

  it('should work with empty Uint8Array', () => {
    const array = new Uint8Array(0);

    const serialized = dehydrateWorkflowArguments(array, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Uint8Array",
          1,
        ],
        ".",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof Uint8Array', context)).toBe(true);
    expect(hydrated.length).toEqual(0);
    expect(hydrated.byteLength).toEqual(0);
  });

  it('should work with empty Int32Array', () => {
    const array = new Int32Array(0);

    const serialized = dehydrateWorkflowArguments(array, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Int32Array",
          1,
        ],
        ".",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof Int32Array', context)).toBe(true);
    expect(hydrated.length).toEqual(0);
    expect(hydrated.byteLength).toEqual(0);
  });

  it('should work with empty Float64Array', () => {
    const array = new Float64Array(0);

    const serialized = dehydrateWorkflowArguments(array, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Float64Array",
          1,
        ],
        ".",
      ]
    `);

    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof Float64Array', context)).toBe(true);
    expect(hydrated.length).toEqual(0);
    expect(hydrated.byteLength).toEqual(0);
  });

  it('should work with Request (without responseWritable)', () => {
    // Mock STABLE_ULID to return a deterministic value
    const originalStableUlid = (globalThis as any)[STABLE_ULID];
    (globalThis as any)[STABLE_ULID] = () => '01ARZ3NDEKTSV4RRFFQ69G5FA1';

    try {
      const request = new Request('https://example.com/api', {
        method: 'POST',
        headers: new Headers([
          ['content-type', 'application/json'],
          ['x-custom', 'value'],
        ]),
        body: 'Hello, world!',
        duplex: 'half',
      } as RequestInit);

      const serialized = dehydrateWorkflowArguments(request, [], mockRunId);
      expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Request",
          1,
        ],
        {
          "body": 12,
          "duplex": 16,
          "headers": 4,
          "method": 2,
          "url": 3,
        },
        "POST",
        "https://example.com/api",
        [
          "Headers",
          5,
        ],
        [
          6,
          9,
        ],
        [
          7,
          8,
        ],
        "content-type",
        "application/json",
        [
          10,
          11,
        ],
        "x-custom",
        "value",
        [
          "ReadableStream",
          13,
        ],
        {
          "name": 14,
          "type": 15,
        },
        "strm_01ARZ3NDEKTSV4RRFFQ69G5FA1",
        "bytes",
        "half",
      ]
    `);

      class OurRequest {
        public method;
        public url;
        public headers;
        public body;
        public duplex;
        constructor(url, init) {
          this.method = init.method;
          this.url = url;
          this.headers = init.headers;
          this.body = init.body;
          this.duplex = init.duplex;
        }
      }
      class OurReadableStream {}
      class OurHeaders {}
      const hydrated = hydrateWorkflowArguments(serialized, {
        Request: OurRequest,
        Headers: OurHeaders,
        ReadableStream: OurReadableStream,
      });
      expect(hydrated).toBeInstanceOf(OurRequest);
      expect(hydrated.method).toBe('POST');
      expect(hydrated.url).toBe('https://example.com/api');
      expect(hydrated.headers).toBeInstanceOf(OurHeaders);
      expect(hydrated.body).toBeInstanceOf(OurReadableStream);
      expect(hydrated.duplex).toBe('half');
    } finally {
      (globalThis as any)[STABLE_ULID] = originalStableUlid;
    }
  });

  it('should work with Request (with responseWritable)', () => {
    // Mock STABLE_ULID to return deterministic values
    const originalStableUlid = (globalThis as any)[STABLE_ULID];
    let ulidCounter = 0;
    (globalThis as any)[STABLE_ULID] = () => {
      const ulids = [
        '01ARZ3NDEKTSV4RRFFQ69G5FA1',
        '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      ] as const;
      return ulids[ulidCounter++];
    };

    try {
      const request = new Request('https://example.com/webhook', {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: 'webhook payload',
        duplex: 'half',
      } as RequestInit);

      // Simulate webhook behavior by attaching a responseWritable stream
      const responseWritable = new WritableStream();
      request[Symbol.for('WEBHOOK_RESPONSE_WRITABLE')] = responseWritable;

      const serialized = dehydrateWorkflowArguments(request, [], mockRunId);
      expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "Request",
          1,
        ],
        {
          "body": 9,
          "duplex": 13,
          "headers": 4,
          "method": 2,
          "responseWritable": 14,
          "url": 3,
        },
        "POST",
        "https://example.com/webhook",
        [
          "Headers",
          5,
        ],
        [
          6,
        ],
        [
          7,
          8,
        ],
        "content-type",
        "application/json",
        [
          "ReadableStream",
          10,
        ],
        {
          "name": 11,
          "type": 12,
        },
        "strm_01ARZ3NDEKTSV4RRFFQ69G5FA1",
        "bytes",
        "half",
        [
          "WritableStream",
          15,
        ],
        {
          "name": 16,
        },
        "strm_01ARZ3NDEKTSV4RRFFQ69G5FA2",
      ]
    `);

      class OurRequest {
        public method;
        public url;
        public headers;
        public body;
        public duplex;
        public responseWritable;
        public respondWith;
        constructor(url, init) {
          this.method = init.method;
          this.url = url;
          this.headers = init.headers;
          this.body = init.body;
          this.duplex = init.duplex;
        }
      }
      class OurReadableStream {}
      class OurWritableStream {}
      class OurHeaders {}
      const hydrated = hydrateWorkflowArguments(serialized, {
        Request: OurRequest,
        Headers: OurHeaders,
        ReadableStream: OurReadableStream,
        WritableStream: OurWritableStream,
      });
      expect(hydrated).toBeInstanceOf(OurRequest);
      expect(hydrated.method).toBe('POST');
      expect(hydrated.url).toBe('https://example.com/webhook');
      expect(hydrated.headers).toBeInstanceOf(OurHeaders);
      expect(hydrated.body).toBeInstanceOf(OurReadableStream);
      expect(hydrated.duplex).toBe('half');
      // responseWritable should be moved to the symbol
      expect(hydrated.responseWritable).toBeUndefined();
      expect(hydrated[Symbol.for('WEBHOOK_RESPONSE_WRITABLE')]).toBeInstanceOf(
        OurWritableStream
      );
      // respondWith should throw an error when called from workflow context
      expect(hydrated.respondWith).toBeInstanceOf(Function);
      expect(() => hydrated.respondWith()).toThrow(
        '`respondWith()` must be called from within a step function'
      );
    } finally {
      (globalThis as any)[STABLE_ULID] = originalStableUlid;
    }
  });

  it('should throw error for an unsupported type', () => {
    class Foo {}
    let err: WorkflowRuntimeError | undefined;
    try {
      dehydrateWorkflowArguments(new Foo(), [], mockRunId);
    } catch (err_) {
      err = err_ as WorkflowRuntimeError;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain(
      `Ensure you're passing serializable types (plain objects, arrays, primitives, Date, RegExp, Map, Set).`
    );
  });
});

describe('workflow return value', () => {
  it('should throw error for an unsupported type', () => {
    class Foo {}
    let err: WorkflowRuntimeError | undefined;
    try {
      dehydrateWorkflowReturnValue(new Foo());
    } catch (err_) {
      err = err_ as WorkflowRuntimeError;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain(
      `Ensure you're returning serializable types (plain objects, arrays, primitives, Date, RegExp, Map, Set).`
    );
  });
});

describe('step arguments', () => {
  it('should throw error for an unsupported type', () => {
    class Foo {}
    let err: WorkflowRuntimeError | undefined;
    try {
      dehydrateStepArguments(new Foo(), globalThis);
    } catch (err_) {
      err = err_ as WorkflowRuntimeError;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain(
      `Ensure you're passing serializable types (plain objects, arrays, primitives, Date, RegExp, Map, Set).`
    );
  });
});

describe('step return value', () => {
  it('should throw error for an unsupported type', () => {
    class Foo {}
    let err: WorkflowRuntimeError | undefined;
    try {
      dehydrateStepReturnValue(new Foo(), [], mockRunId);
    } catch (err_) {
      err = err_ as WorkflowRuntimeError;
    }

    expect(err).toBeDefined();
    expect(err?.message).toContain(
      `Ensure you're returning serializable types (plain objects, arrays, primitives, Date, RegExp, Map, Set).`
    );
  });
});

describe('step function serialization', () => {
  const { globalThis: vmGlobalThis } = createContext({
    seed: 'test',
    fixedTimestamp: 1714857600000,
  });

  it('should detect step function by checking for stepId property', () => {
    const stepName = 'myStep';
    const stepFn = async (x: number) => x * 2;

    // Attach stepId like useStep() does
    Object.defineProperty(stepFn, 'stepId', {
      value: stepName,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Verify the property is attached correctly
    expect((stepFn as any).stepId).toBe(stepName);
  });

  it('should not have stepId on regular functions', () => {
    const regularFn = async (x: number) => x * 2;

    // Regular functions should not have stepId
    expect((regularFn as any).stepId).toBeUndefined();
  });

  it('should lookup registered step function by name', () => {
    const stepName = 'myRegisteredStep';
    const stepFn = async (x: number) => x * 2;

    // Register the step function
    registerStepFunction(stepName, stepFn);

    // Should be retrievable by name
    const retrieved = getStepFunction(stepName);
    expect(retrieved).toBe(stepFn);
  });

  it('should return undefined for non-existent registered step function', () => {
    const retrieved = getStepFunction('nonExistentStep');
    expect(retrieved).toBeUndefined();
  });

  it('should deserialize step function name through reviver', () => {
    const stepName = 'testStep';
    const stepFn = async () => 42;

    // Register the step function
    registerStepFunction(stepName, stepFn);

    // Get the reviver and test it directly
    const revivers = getCommonRevivers(vmGlobalThis);
    const result = revivers.StepFunction({ stepId: stepName });

    expect(result).toBe(stepFn);
  });

  it('should throw error when reviver cannot find registered step function', () => {
    const revivers = getCommonRevivers(vmGlobalThis);

    let err: Error | undefined;
    try {
      revivers.StepFunction({ stepId: 'nonExistentStep' });
    } catch (err_) {
      err = err_ as Error;
    }

    expect(err).toBeDefined();
    expect(err?.message).toContain('Step function "nonExistentStep" not found');
    expect(err?.message).toContain('Make sure the step function is registered');
  });

  it('should dehydrate step function passed as argument to a step', () => {
    const stepName = 'step//workflows/test.ts//myStep';
    const stepFn = async (x: number) => x * 2;

    // Register the step function
    registerStepFunction(stepName, stepFn);

    // Attach stepId to the function (like useStep() does)
    Object.defineProperty(stepFn, 'stepId', {
      value: stepName,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Simulate passing a step function as an argument within a workflow
    // When calling a step from within a workflow context
    const args = [stepFn, 42];

    // This should serialize the step function by its name using the reducer
    const dehydrated = dehydrateStepArguments(args, globalThis);

    // Verify it dehydrated successfully
    expect(dehydrated).toBeDefined();
    expect(Array.isArray(dehydrated)).toBe(true);
    // The dehydrated structure is the flattened format from devalue
    // It should contain the step function serialized as its name
    expect(dehydrated).toContain(stepName);
    expect(dehydrated).toContain(42);
  });

  it('should dehydrate and hydrate step function with closure variables', async () => {
    const stepName = 'step//workflows/test.ts//calculate';

    // Create a step function that accesses closure variables
    const { __private_getClosureVars } = await import('./private.js');
    const { contextStorage } = await import('./step/context-storage.js');

    const stepFn = async (x: number) => {
      const { multiplier, prefix } = __private_getClosureVars();
      const result = x * multiplier;
      return `${prefix}${result}`;
    };

    // Register the step function
    registerStepFunction(stepName, stepFn);

    // Simulate what useStep() does - attach stepId and closure vars function
    Object.defineProperty(stepFn, 'stepId', {
      value: stepName,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    const closureVars = { multiplier: 3, prefix: 'Result: ' };
    Object.defineProperty(stepFn, '__closureVarsFn', {
      value: () => closureVars,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Serialize the step function with closure variables
    const args = [stepFn, 7];
    const dehydrated = dehydrateStepArguments(args, globalThis);

    // Verify it serialized
    expect(dehydrated).toBeDefined();
    const serialized = JSON.stringify(dehydrated);
    expect(serialized).toContain(stepName);
    expect(serialized).toContain('multiplier');
    expect(serialized).toContain('prefix');

    // Now hydrate it back
    const hydrated = hydrateStepArguments(
      dehydrated,
      [],
      'test-run-123',
      vmGlobalThis
    );
    expect(Array.isArray(hydrated)).toBe(true);
    expect(hydrated).toHaveLength(2);

    const hydratedStepFn = hydrated[0];
    const hydratedArg = hydrated[1];

    expect(typeof hydratedStepFn).toBe('function');
    expect(hydratedArg).toBe(7);

    // Invoke the hydrated step function within a context
    const result = await contextStorage.run(
      {
        stepMetadata: {
          stepId: 'test-step',
          stepStartedAt: new Date(),
          attempt: 1,
        },
        workflowMetadata: {
          workflowRunId: 'test-run',
          workflowStartedAt: new Date(),
          url: 'http://localhost:3000',
        },
        ops: [],
      },
      () => hydratedStepFn(7)
    );

    // Verify the closure variables were accessible and used correctly
    expect(result).toBe('Result: 21');
  });

  it('should serialize step function to object through reducer', () => {
    const stepName = 'step//workflows/test.ts//anotherStep';
    const stepFn = async () => 'result';

    // Attach stepId to the function (like useStep() does)
    Object.defineProperty(stepFn, 'stepId', {
      value: stepName,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Get the reducer and verify it detects the step function
    const reducer = getWorkflowReducers(globalThis).StepFunction;
    const result = reducer(stepFn);

    // Should return object with stepId
    expect(result).toEqual({ stepId: stepName });
  });
});

describe('custom class serialization', () => {
  const { globalThis: vmGlobalThis } = createContext({
    seed: 'test',
    fixedTimestamp: 1714857600000,
  });

  it('should serialize and deserialize a class with WORKFLOW_SERIALIZE/DESERIALIZE', () => {
    class Point {
      static classId = 'test/Point';

      constructor(
        public x: number,
        public y: number
      ) {}

      static [WORKFLOW_SERIALIZE](instance: Point) {
        return { x: instance.x, y: instance.y };
      }

      static [WORKFLOW_DESERIALIZE](data: { x: number; y: number }) {
        return new Point(data.x, data.y);
      }
    }

    // Register the class for deserialization
    registerSerializationClass('test/Point', Point);

    const point = new Point(10, 20);
    const serialized = dehydrateWorkflowArguments(point, [], mockRunId);

    // Verify it serialized with the CustomSerializable type
    expect(serialized).toBeDefined();
    expect(Array.isArray(serialized)).toBe(true);
    // Check that the serialized data contains the classId
    expect(JSON.stringify(serialized)).toContain('test/Point');

    // Hydrate it back
    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);
    expect(hydrated).toBeInstanceOf(Point);
    expect(hydrated.x).toBe(10);
    expect(hydrated.y).toBe(20);
  });

  it('should serialize nested custom serializable objects', () => {
    class Vector {
      static classId = 'test/Vector';

      constructor(
        public dx: number,
        public dy: number
      ) {}

      static [WORKFLOW_SERIALIZE](instance: Vector) {
        return { dx: instance.dx, dy: instance.dy };
      }

      static [WORKFLOW_DESERIALIZE](data: { dx: number; dy: number }) {
        return new Vector(data.dx, data.dy);
      }
    }

    // Register the class for deserialization
    registerSerializationClass('test/Vector', Vector);

    const data = {
      name: 'test',
      vector: new Vector(5, 10),
      nested: {
        anotherVector: new Vector(1, 2),
      },
    };

    const serialized = dehydrateWorkflowArguments(data, [], mockRunId);
    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);

    expect(hydrated.name).toBe('test');
    expect(hydrated.vector).toBeInstanceOf(Vector);
    expect(hydrated.vector.dx).toBe(5);
    expect(hydrated.vector.dy).toBe(10);
    expect(hydrated.nested.anotherVector).toBeInstanceOf(Vector);
    expect(hydrated.nested.anotherVector.dx).toBe(1);
    expect(hydrated.nested.anotherVector.dy).toBe(2);
  });

  it('should serialize custom class in an array', () => {
    class Item {
      static classId = 'test/Item';

      constructor(public id: string) {}

      static [WORKFLOW_SERIALIZE](instance: Item) {
        return { id: instance.id };
      }

      static [WORKFLOW_DESERIALIZE](data: { id: string }) {
        return new Item(data.id);
      }
    }

    // Register the class for deserialization
    registerSerializationClass('test/Item', Item);

    const items = [new Item('a'), new Item('b'), new Item('c')];

    const serialized = dehydrateWorkflowArguments(items, [], mockRunId);
    const hydrated = hydrateWorkflowArguments(serialized, vmGlobalThis);

    expect(Array.isArray(hydrated)).toBe(true);
    expect(hydrated).toHaveLength(3);
    expect(hydrated[0]).toBeInstanceOf(Item);
    expect(hydrated[0].id).toBe('a');
    expect(hydrated[1]).toBeInstanceOf(Item);
    expect(hydrated[1].id).toBe('b');
    expect(hydrated[2]).toBeInstanceOf(Item);
    expect(hydrated[2].id).toBe('c');
  });

  it('should work with step arguments', () => {
    class Config {
      static classId = 'test/Config';

      constructor(
        public setting: string,
        public value: number
      ) {}

      static [WORKFLOW_SERIALIZE](instance: Config) {
        return { setting: instance.setting, value: instance.value };
      }

      static [WORKFLOW_DESERIALIZE](data: { setting: string; value: number }) {
        return new Config(data.setting, data.value);
      }
    }

    // Register the class for deserialization
    registerSerializationClass('test/Config', Config);

    const config = new Config('maxRetries', 3);
    const serialized = dehydrateStepArguments([config], globalThis);
    const hydrated = hydrateStepArguments(
      serialized,
      [],
      mockRunId,
      globalThis
    );

    expect(Array.isArray(hydrated)).toBe(true);
    expect(hydrated[0]).toBeInstanceOf(Config);
    expect(hydrated[0].setting).toBe('maxRetries');
    expect(hydrated[0].value).toBe(3);
  });

  it('should work with step return values', () => {
    class Result {
      static classId = 'test/Result';

      constructor(
        public success: boolean,
        public data: string
      ) {}

      static [WORKFLOW_SERIALIZE](instance: Result) {
        return { success: instance.success, data: instance.data };
      }

      static [WORKFLOW_DESERIALIZE](data: { success: boolean; data: string }) {
        return new Result(data.success, data.data);
      }
    }

    // Register the class for deserialization
    registerSerializationClass('test/Result', Result);

    const result = new Result(true, 'completed');
    const serialized = dehydrateStepReturnValue(result, [], mockRunId);
    // Step return values are hydrated with workflow revivers
    const hydrated = hydrateWorkflowArguments(serialized, globalThis);

    expect(hydrated).toBeInstanceOf(Result);
    expect(hydrated.success).toBe(true);
    expect(hydrated.data).toBe('completed');
  });

  it('should not serialize classes without WORKFLOW_SERIALIZE', () => {
    class PlainClass {
      constructor(public value: string) {}
    }

    const instance = new PlainClass('test');

    // Should throw because PlainClass is not serializable
    expect(() => dehydrateWorkflowArguments(instance, [], mockRunId)).toThrow();
  });

  it('should throw error when classId is missing', () => {
    class NoClassId {
      // Missing static classId!
      constructor(public value: string) {}

      static [WORKFLOW_SERIALIZE](instance: NoClassId) {
        return { value: instance.value };
      }

      static [WORKFLOW_DESERIALIZE](data: { value: string }) {
        return new NoClassId(data.value);
      }
    }

    const instance = new NoClassId('test');

    // Should throw with our specific error message about missing classId
    let errorMessage = '';
    try {
      dehydrateWorkflowArguments(instance, [], mockRunId);
    } catch (e: any) {
      errorMessage = e.cause?.message || e.message;
    }
    expect(errorMessage).toMatch(/must have a static "classId" property/);
  });

  it('should serialize class with complex data types in payload', () => {
    class ComplexData {
      static classId = 'test/ComplexData';

      constructor(
        public items: Map<string, number>,
        public created: Date
      ) {}

      static [WORKFLOW_SERIALIZE](instance: ComplexData) {
        return { items: instance.items, created: instance.created };
      }

      static [WORKFLOW_DESERIALIZE](data: {
        items: Map<string, number>;
        created: Date;
      }) {
        return new ComplexData(data.items, data.created);
      }
    }

    // Register the class for deserialization
    registerSerializationClass('test/ComplexData', ComplexData);

    const map = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const date = new Date('2025-01-01T00:00:00.000Z');
    const complex = new ComplexData(map, date);

    const serialized = dehydrateWorkflowArguments(complex, [], mockRunId);
    const hydrated = hydrateWorkflowArguments(serialized, globalThis);

    expect(hydrated).toBeInstanceOf(ComplexData);
    expect(hydrated.items).toBeInstanceOf(Map);
    expect(hydrated.items.get('a')).toBe(1);
    expect(hydrated.items.get('b')).toBe(2);
    expect(hydrated.created).toBeInstanceOf(Date);
    expect(hydrated.created.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });
});
