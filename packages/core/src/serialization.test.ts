import { runInContext } from 'node:vm';
import type { WorkflowRuntimeError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  dehydrateWorkflowReturnValue,
  getStreamType,
  hydrateWorkflowArguments,
} from './serialization.js';
import { STREAM_NAME_SYMBOL } from './symbols.js';
import { createContext } from './vm/index.js';

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
    const serialized = dehydrateWorkflowArguments(date, []);
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
    const serialized = dehydrateWorkflowArguments(date, []);
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
    const serialized = dehydrateWorkflowArguments(bigInt, []);
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
    const serialized = dehydrateWorkflowArguments(bigInt, []);
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
    const serialized = dehydrateWorkflowArguments(map, []);
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
    const serialized = dehydrateWorkflowArguments(set, []);
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
    const serialized = dehydrateWorkflowArguments(stream, []);
    const uuid = serialized[2];
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "WritableStream",
          1,
        ],
        {
          "name": 2,
        },
        "${uuid}",
      ]
    `);

    class OurWritableStream {}
    const hydrated = hydrateWorkflowArguments(serialized, {
      WritableStream: OurWritableStream,
    });
    expect(hydrated).toBeInstanceOf(OurWritableStream);
    expect(hydrated[STREAM_NAME_SYMBOL]).toEqual(uuid);
  });

  it('should work with ReadableStream', () => {
    const stream = new ReadableStream();
    const serialized = dehydrateWorkflowArguments(stream, []);
    const uuid = serialized[2];
    expect(serialized).toMatchInlineSnapshot(`
      [
        [
          "ReadableStream",
          1,
        ],
        {
          "name": 2,
        },
        "${uuid}",
      ]
    `);

    class OurReadableStream {}
    const hydrated = hydrateWorkflowArguments(serialized, {
      ReadableStream: OurReadableStream,
    });
    expect(hydrated).toBeInstanceOf(OurReadableStream);
    expect(hydrated[STREAM_NAME_SYMBOL]).toEqual(uuid);
  });

  it('should work with Headers', () => {
    const headers = new Headers();
    headers.set('foo', 'bar');
    headers.append('set-cookie', 'a');
    headers.append('set-cookie', 'b');
    const serialized = dehydrateWorkflowArguments(headers, []);
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
    const serialized = dehydrateWorkflowArguments(response, []);
    const bodyUuid = serialized[serialized.length - 3];
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
        "${bodyUuid}",
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

    const serialized = dehydrateWorkflowArguments(params, []);
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

    const serialized = dehydrateWorkflowArguments(params, []);
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

    const serialized = dehydrateWorkflowArguments(buffer, []);
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

    const serialized = dehydrateWorkflowArguments(array, []);
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

    const serialized = dehydrateWorkflowArguments(array, []);
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

    const serialized = dehydrateWorkflowArguments(array, []);
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
    // Mock crypto.randomUUID to return a deterministic value
    const originalRandomUUID = globalThis.crypto.randomUUID;
    globalThis.crypto.randomUUID = () =>
      '00000000-0000-0000-0000-000000000001' as `${string}-${string}-${string}-${string}-${string}`;

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

      const serialized = dehydrateWorkflowArguments(request, []);
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
        "00000000-0000-0000-0000-000000000001",
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
      globalThis.crypto.randomUUID = originalRandomUUID;
    }
  });

  it('should work with Request (with responseWritable)', () => {
    // Mock crypto.randomUUID to return deterministic values
    const originalRandomUUID = globalThis.crypto.randomUUID;
    let uuidCounter = 0;
    globalThis.crypto.randomUUID = () => {
      const uuids = [
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
      ] as const;
      return uuids[
        uuidCounter++
      ] as `${string}-${string}-${string}-${string}-${string}`;
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

      const serialized = dehydrateWorkflowArguments(request, []);
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
        "00000000-0000-0000-0000-000000000001",
        "bytes",
        "half",
        [
          "WritableStream",
          15,
        ],
        {
          "name": 16,
        },
        "00000000-0000-0000-0000-000000000002",
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
      globalThis.crypto.randomUUID = originalRandomUUID;
    }
  });

  it('should throw error for an unsupported type', () => {
    class Foo {}
    let err: WorkflowRuntimeError | undefined;
    try {
      dehydrateWorkflowArguments(new Foo(), []);
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
      dehydrateStepReturnValue(new Foo(), []);
    } catch (err_) {
      err = err_ as WorkflowRuntimeError;
    }

    expect(err).toBeDefined();
    expect(err?.message).toContain(
      `Ensure you're returning serializable types (plain objects, arrays, primitives, Date, RegExp, Map, Set).`
    );
  });
});
