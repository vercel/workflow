import { runInContext } from 'node:vm';
import type { WorkflowRuntimeError } from '@workflow/errors';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import { describe, expect, it } from 'vitest';
import { registerSerializationClass } from './class-serialization.js';
import { getStepFunction, registerStepFunction } from './private.js';
import {
  decodeFormatPrefix,
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  dehydrateWorkflowReturnValue,
  getCommonRevivers,
  getDeserializeStream,
  getSerializeStream,
  getStreamType,
  getWorkflowReducers,
  hydrateStepArguments,
  hydrateStepReturnValue,
  hydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
  SerializationFormat,
} from './serialization.js';
import { STABLE_ULID, STREAM_NAME_SYMBOL } from './symbols.js';
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

  it('should work with Date', async () => {
    const date = new Date('2025-07-17T04:30:34.824Z');
    const serialized = await dehydrateWorkflowArguments(date, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        68,
        97,
        116,
        101,
        34,
        44,
        49,
        93,
        44,
        34,
        50,
        48,
        50,
        53,
        45,
        48,
        55,
        45,
        49,
        55,
        84,
        48,
        52,
        58,
        51,
        48,
        58,
        51,
        52,
        46,
        56,
        50,
        52,
        90,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;

    expect(runInContext('val instanceof Date', context)).toBe(true);
    expect(hydrated.getTime()).toEqual(date.getTime());
  });

  it('should work with invalid Date', async () => {
    const date = new Date('asdf');
    const serialized = await dehydrateWorkflowArguments(date, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        68,
        97,
        116,
        101,
        34,
        44,
        49,
        93,
        44,
        34,
        46,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;

    expect(runInContext('val instanceof Date', context)).toBe(true);
    expect(hydrated.getTime()).toEqual(NaN);
  });

  it('should work with BigInt', async () => {
    const bigInt = BigInt('9007199254740992');
    const serialized = await dehydrateWorkflowArguments(bigInt, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        66,
        105,
        103,
        73,
        110,
        116,
        34,
        44,
        49,
        93,
        44,
        34,
        57,
        48,
        48,
        55,
        49,
        57,
        57,
        50,
        53,
        52,
        55,
        52,
        48,
        57,
        57,
        50,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    expect(hydrated).toBe(BigInt(9007199254740992));
    expect(typeof hydrated).toBe('bigint');
  });

  it('should work with BigInt negative', async () => {
    const bigInt = BigInt('-12345678901234567890');
    const serialized = await dehydrateWorkflowArguments(bigInt, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        66,
        105,
        103,
        73,
        110,
        116,
        34,
        44,
        49,
        93,
        44,
        34,
        45,
        49,
        50,
        51,
        52,
        53,
        54,
        55,
        56,
        57,
        48,
        49,
        50,
        51,
        52,
        53,
        54,
        55,
        56,
        57,
        48,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    expect(hydrated).toBe(BigInt('-12345678901234567890'));
    expect(typeof hydrated).toBe('bigint');
  });

  it('should work with Map', async () => {
    const map = new Map([
      [2, 'foo'],
      [6, 'bar'],
    ]);
    const serialized = await dehydrateWorkflowArguments(map, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        77,
        97,
        112,
        34,
        44,
        49,
        93,
        44,
        91,
        50,
        44,
        53,
        93,
        44,
        91,
        51,
        44,
        52,
        93,
        44,
        50,
        44,
        34,
        102,
        111,
        111,
        34,
        44,
        91,
        54,
        44,
        55,
        93,
        44,
        54,
        44,
        34,
        98,
        97,
        114,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;

    expect(runInContext('val instanceof Map', context)).toBe(true);
  });

  it('should work with Set', async () => {
    const set = new Set([1, '2', true]);
    const serialized = await dehydrateWorkflowArguments(set, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        83,
        101,
        116,
        34,
        44,
        49,
        93,
        44,
        91,
        50,
        44,
        51,
        44,
        52,
        93,
        44,
        49,
        44,
        34,
        50,
        34,
        44,
        116,
        114,
        117,
        101,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;

    expect(runInContext('val instanceof Set', context)).toBe(true);
  });

  it('should work with WritableStream', async () => {
    const stream = new WritableStream();
    const serialized = await dehydrateWorkflowArguments(stream, [], mockRunId);
    expect(serialized instanceof Uint8Array).toBe(true);
    // Verify the serialized data contains WritableStream reference
    const serializedStr = new TextDecoder().decode(serialized);
    expect(serializedStr).toContain('WritableStream');

    class OurWritableStream {}
    const hydrated = await hydrateWorkflowArguments(serialized, {
      WritableStream: OurWritableStream,
    });
    expect(hydrated).toBeInstanceOf(OurWritableStream);
    const streamName = hydrated[STREAM_NAME_SYMBOL];
    expect(streamName).toMatch(/^strm_[0-9A-Z]{26}$/);
  });

  it('should work with ReadableStream', async () => {
    const stream = new ReadableStream();
    const serialized = await dehydrateWorkflowArguments(stream, [], mockRunId);
    expect(serialized instanceof Uint8Array).toBe(true);
    // Verify the serialized data contains ReadableStream reference
    const serializedStr = new TextDecoder().decode(serialized);
    expect(serializedStr).toContain('ReadableStream');

    class OurReadableStream {}
    const hydrated = await hydrateWorkflowArguments(serialized, {
      ReadableStream: OurReadableStream,
    });
    expect(hydrated).toBeInstanceOf(OurReadableStream);
    const streamName = hydrated[STREAM_NAME_SYMBOL];
    expect(streamName).toMatch(/^strm_[0-9A-Z]{26}$/);
  });

  it('should work with Headers', async () => {
    const headers = new Headers();
    headers.set('foo', 'bar');
    headers.append('set-cookie', 'a');
    headers.append('set-cookie', 'b');
    const serialized = await dehydrateWorkflowArguments(headers, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        72,
        101,
        97,
        100,
        101,
        114,
        115,
        34,
        44,
        49,
        93,
        44,
        91,
        50,
        44,
        53,
        44,
        56,
        93,
        44,
        91,
        51,
        44,
        52,
        93,
        44,
        34,
        102,
        111,
        111,
        34,
        44,
        34,
        98,
        97,
        114,
        34,
        44,
        91,
        54,
        44,
        55,
        93,
        44,
        34,
        115,
        101,
        116,
        45,
        99,
        111,
        111,
        107,
        105,
        101,
        34,
        44,
        34,
        97,
        34,
        44,
        91,
        54,
        44,
        57,
        93,
        44,
        34,
        98,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    expect(hydrated).toBeInstanceOf(Headers);
    expect(hydrated.get('foo')).toEqual('bar');
    expect(hydrated.get('set-cookie')).toEqual('a, b');
  });

  it('should work with Response', async () => {
    const response = new Response('Hello, world!', {
      status: 202,
      statusText: 'Custom',
      headers: new Headers([
        ['foo', 'bar'],
        ['set-cookie', 'a'],
        ['set-cookie', 'b'],
      ]),
    });
    const serialized = await dehydrateWorkflowArguments(
      response,
      [],
      mockRunId
    );
    expect(serialized instanceof Uint8Array).toBe(true);
    // Verify the serialized data contains Response reference
    const serializedStr = new TextDecoder().decode(serialized);
    expect(serializedStr).toContain('Response');
    expect(serializedStr).toContain('ReadableStream');

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
    const hydrated = await hydrateWorkflowArguments(serialized, {
      Headers: OurHeaders,
      Response: OurResponse,
      ReadableStream: OurReadableStream,
    });
    expect(hydrated).toBeInstanceOf(OurResponse);
    expect(hydrated.headers).toBeInstanceOf(OurHeaders);
    expect(hydrated.body).toBeInstanceOf(OurReadableStream);
    // Verify stream name is generated correctly
    const bodyStreamName = hydrated.body[STREAM_NAME_SYMBOL];
    expect(bodyStreamName).toMatch(/^strm_[0-9A-Z]{26}$/);
  });

  it('should work with URLSearchParams', async () => {
    const params = new URLSearchParams('a=1&b=2&a=3');

    const serialized = await dehydrateWorkflowArguments(params, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        85,
        82,
        76,
        83,
        101,
        97,
        114,
        99,
        104,
        80,
        97,
        114,
        97,
        109,
        115,
        34,
        44,
        49,
        93,
        44,
        34,
        97,
        61,
        49,
        38,
        98,
        61,
        50,
        38,
        97,
        61,
        51,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
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

  it('should work with empty URLSearchParams', async () => {
    const params = new URLSearchParams();

    const serialized = await dehydrateWorkflowArguments(params, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        85,
        82,
        76,
        83,
        101,
        97,
        114,
        99,
        104,
        80,
        97,
        114,
        97,
        109,
        115,
        34,
        44,
        49,
        93,
        44,
        34,
        46,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof URLSearchParams', context)).toBe(true);
    expect(hydrated.toString()).toEqual('');
    expect(Array.from(hydrated.entries())).toEqual([]);
  });

  it('should work with empty ArrayBuffer', async () => {
    const buffer = new ArrayBuffer(0);

    const serialized = await dehydrateWorkflowArguments(buffer, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        65,
        114,
        114,
        97,
        121,
        66,
        117,
        102,
        102,
        101,
        114,
        34,
        44,
        49,
        93,
        44,
        34,
        46,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof ArrayBuffer', context)).toBe(true);
    expect(hydrated.byteLength).toEqual(0);
  });

  it('should work with empty Uint8Array', async () => {
    const array = new Uint8Array(0);

    const serialized = await dehydrateWorkflowArguments(array, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        85,
        105,
        110,
        116,
        56,
        65,
        114,
        114,
        97,
        121,
        34,
        44,
        49,
        93,
        44,
        34,
        46,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof Uint8Array', context)).toBe(true);
    expect(hydrated.length).toEqual(0);
    expect(hydrated.byteLength).toEqual(0);
  });

  it('should work with empty Int32Array', async () => {
    const array = new Int32Array(0);

    const serialized = await dehydrateWorkflowArguments(array, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        73,
        110,
        116,
        51,
        50,
        65,
        114,
        114,
        97,
        121,
        34,
        44,
        49,
        93,
        44,
        34,
        46,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof Int32Array', context)).toBe(true);
    expect(hydrated.length).toEqual(0);
    expect(hydrated.byteLength).toEqual(0);
  });

  it('should work with empty Float64Array', async () => {
    const array = new Float64Array(0);

    const serialized = await dehydrateWorkflowArguments(array, [], mockRunId);
    expect(serialized).toMatchInlineSnapshot(`
      Uint8Array [
        100,
        101,
        118,
        108,
        91,
        91,
        34,
        70,
        108,
        111,
        97,
        116,
        54,
        52,
        65,
        114,
        114,
        97,
        121,
        34,
        44,
        49,
        93,
        44,
        34,
        46,
        34,
        93,
      ]
    `);

    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    vmGlobalThis.val = hydrated;
    expect(runInContext('val instanceof Float64Array', context)).toBe(true);
    expect(hydrated.length).toEqual(0);
    expect(hydrated.byteLength).toEqual(0);
  });

  it('should work with Request (without responseWritable)', async () => {
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

      const serialized = await dehydrateWorkflowArguments(
        request,
        [],
        mockRunId
      );
      expect(serialized).toMatchInlineSnapshot(`
        Uint8Array [
          100,
          101,
          118,
          108,
          91,
          91,
          34,
          82,
          101,
          113,
          117,
          101,
          115,
          116,
          34,
          44,
          49,
          93,
          44,
          123,
          34,
          109,
          101,
          116,
          104,
          111,
          100,
          34,
          58,
          50,
          44,
          34,
          117,
          114,
          108,
          34,
          58,
          51,
          44,
          34,
          104,
          101,
          97,
          100,
          101,
          114,
          115,
          34,
          58,
          52,
          44,
          34,
          98,
          111,
          100,
          121,
          34,
          58,
          49,
          50,
          44,
          34,
          100,
          117,
          112,
          108,
          101,
          120,
          34,
          58,
          49,
          54,
          125,
          44,
          34,
          80,
          79,
          83,
          84,
          34,
          44,
          34,
          104,
          116,
          116,
          112,
          115,
          58,
          47,
          47,
          101,
          120,
          97,
          109,
          112,
          108,
          101,
          46,
          99,
          111,
          109,
          47,
          97,
          112,
          105,
          34,
          44,
          91,
          34,
          72,
          101,
          97,
          100,
          101,
          114,
          115,
          34,
          44,
          53,
          93,
          44,
          91,
          54,
          44,
          57,
          93,
          44,
          91,
          55,
          44,
          56,
          93,
          44,
          34,
          99,
          111,
          110,
          116,
          101,
          110,
          116,
          45,
          116,
          121,
          112,
          101,
          34,
          44,
          34,
          97,
          112,
          112,
          108,
          105,
          99,
          97,
          116,
          105,
          111,
          110,
          47,
          106,
          115,
          111,
          110,
          34,
          44,
          91,
          49,
          48,
          44,
          49,
          49,
          93,
          44,
          34,
          120,
          45,
          99,
          117,
          115,
          116,
          111,
          109,
          34,
          44,
          34,
          118,
          97,
          108,
          117,
          101,
          34,
          44,
          91,
          34,
          82,
          101,
          97,
          100,
          97,
          98,
          108,
          101,
          83,
          116,
          114,
          101,
          97,
          109,
          34,
          44,
          49,
          51,
          93,
          44,
          123,
          34,
          110,
          97,
          109,
          101,
          34,
          58,
          49,
          52,
          44,
          34,
          116,
          121,
          112,
          101,
          34,
          58,
          49,
          53,
          125,
          44,
          34,
          115,
          116,
          114,
          109,
          95,
          48,
          49,
          65,
          82,
          90,
          51,
          78,
          68,
          69,
          75,
          84,
          83,
          86,
          52,
          82,
          82,
          70,
          70,
          81,
          54,
          57,
          71,
          53,
          70,
          65,
          49,
          34,
          44,
          34,
          98,
          121,
          116,
          101,
          115,
          34,
          44,
          34,
          104,
          97,
          108,
          102,
          34,
          93,
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
      const hydrated = await hydrateWorkflowArguments(serialized, {
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

  it('should work with Request (with responseWritable)', async () => {
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

      const serialized = await dehydrateWorkflowArguments(
        request,
        [],
        mockRunId
      );
      expect(serialized).toMatchInlineSnapshot(`
        Uint8Array [
          100,
          101,
          118,
          108,
          91,
          91,
          34,
          82,
          101,
          113,
          117,
          101,
          115,
          116,
          34,
          44,
          49,
          93,
          44,
          123,
          34,
          109,
          101,
          116,
          104,
          111,
          100,
          34,
          58,
          50,
          44,
          34,
          117,
          114,
          108,
          34,
          58,
          51,
          44,
          34,
          104,
          101,
          97,
          100,
          101,
          114,
          115,
          34,
          58,
          52,
          44,
          34,
          98,
          111,
          100,
          121,
          34,
          58,
          57,
          44,
          34,
          100,
          117,
          112,
          108,
          101,
          120,
          34,
          58,
          49,
          51,
          44,
          34,
          114,
          101,
          115,
          112,
          111,
          110,
          115,
          101,
          87,
          114,
          105,
          116,
          97,
          98,
          108,
          101,
          34,
          58,
          49,
          52,
          125,
          44,
          34,
          80,
          79,
          83,
          84,
          34,
          44,
          34,
          104,
          116,
          116,
          112,
          115,
          58,
          47,
          47,
          101,
          120,
          97,
          109,
          112,
          108,
          101,
          46,
          99,
          111,
          109,
          47,
          119,
          101,
          98,
          104,
          111,
          111,
          107,
          34,
          44,
          91,
          34,
          72,
          101,
          97,
          100,
          101,
          114,
          115,
          34,
          44,
          53,
          93,
          44,
          91,
          54,
          93,
          44,
          91,
          55,
          44,
          56,
          93,
          44,
          34,
          99,
          111,
          110,
          116,
          101,
          110,
          116,
          45,
          116,
          121,
          112,
          101,
          34,
          44,
          34,
          97,
          112,
          112,
          108,
          105,
          99,
          97,
          116,
          105,
          111,
          110,
          47,
          106,
          115,
          111,
          110,
          34,
          44,
          91,
          34,
          82,
          101,
          97,
          100,
          97,
          98,
          108,
          101,
          83,
          116,
          114,
          101,
          97,
          109,
          34,
          44,
          49,
          48,
          93,
          44,
          123,
          34,
          110,
          97,
          109,
          101,
          34,
          58,
          49,
          49,
          44,
          34,
          116,
          121,
          112,
          101,
          34,
          58,
          49,
          50,
          125,
          44,
          34,
          115,
          116,
          114,
          109,
          95,
          48,
          49,
          65,
          82,
          90,
          51,
          78,
          68,
          69,
          75,
          84,
          83,
          86,
          52,
          82,
          82,
          70,
          70,
          81,
          54,
          57,
          71,
          53,
          70,
          65,
          49,
          34,
          44,
          34,
          98,
          121,
          116,
          101,
          115,
          34,
          44,
          34,
          104,
          97,
          108,
          102,
          34,
          44,
          91,
          34,
          87,
          114,
          105,
          116,
          97,
          98,
          108,
          101,
          83,
          116,
          114,
          101,
          97,
          109,
          34,
          44,
          49,
          53,
          93,
          44,
          123,
          34,
          110,
          97,
          109,
          101,
          34,
          58,
          49,
          54,
          125,
          44,
          34,
          115,
          116,
          114,
          109,
          95,
          48,
          49,
          65,
          82,
          90,
          51,
          78,
          68,
          69,
          75,
          84,
          83,
          86,
          52,
          82,
          82,
          70,
          70,
          81,
          54,
          57,
          71,
          53,
          70,
          65,
          50,
          34,
          93,
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
      const hydrated = await hydrateWorkflowArguments(serialized, {
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

  it('should throw error for an unsupported type', async () => {
    class Foo {}
    let err: WorkflowRuntimeError | undefined;
    try {
      await dehydrateWorkflowArguments(new Foo(), [], mockRunId);
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
  it('should throw error for an unsupported type', async () => {
    class Foo {}
    let err: WorkflowRuntimeError | undefined;
    try {
      await dehydrateWorkflowReturnValue(new Foo());
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
  it('should throw error for an unsupported type', async () => {
    class Foo {}
    let err: WorkflowRuntimeError | undefined;
    try {
      await dehydrateStepArguments(new Foo(), globalThis);
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
  it('should throw error for an unsupported type', async () => {
    class Foo {}
    let err: WorkflowRuntimeError | undefined;
    try {
      await dehydrateStepReturnValue(new Foo(), [], mockRunId);
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

  it('should deserialize step function name through reviver', async () => {
    const stepName = 'step//test//testStep';
    const stepFn = async () => 42;

    // Register the step function
    registerStepFunction(stepName, stepFn);

    // Create a function with stepId property (like registerStepFunction does)
    const fnWithStepId = async () => 42;
    Object.defineProperty(fnWithStepId, 'stepId', {
      value: stepName,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Serialize using workflow reducers (which handle StepFunction)
    const dehydrated = await dehydrateStepArguments([fnWithStepId], globalThis);

    // Hydrate it back using step revivers
    const ops: Promise<void>[] = [];
    const hydrated = await hydrateStepArguments(
      dehydrated,
      ops,
      mockRunId,
      globalThis
    );

    // The hydrated result should be the registered step function
    expect(hydrated[0]).toBe(stepFn);
  });

  it('should deserialize step function using workflows/example path aliases', async () => {
    const registeredStepId = 'step//./example/workflows/99_e2e//doubleNumber';
    const aliasedStepId = 'step//./workflows/99_e2e//doubleNumber';
    const stepFn = async () => 42;

    registerStepFunction(registeredStepId, stepFn);

    const fnWithStepId = async () => 42;
    Object.defineProperty(fnWithStepId, 'stepId', {
      value: aliasedStepId,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    const dehydrated = await dehydrateStepArguments([fnWithStepId], globalThis);
    const ops: Promise<void>[] = [];
    const hydrated = await hydrateStepArguments(
      dehydrated,
      ops,
      mockRunId,
      globalThis
    );
    const result = hydrated[0];

    expect(result).toBe(stepFn);
  });

  it('should deserialize step function using workflows/src path aliases', async () => {
    const registeredStepId = 'step//./src/workflows/99_e2e//doubleFromSrc';
    const aliasedStepId = 'step//./workflows/99_e2e//doubleFromSrc';
    const stepFn = async () => 42;

    registerStepFunction(registeredStepId, stepFn);

    const fnWithStepId = async () => 42;
    Object.defineProperty(fnWithStepId, 'stepId', {
      value: aliasedStepId,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    const dehydrated = await dehydrateStepArguments([fnWithStepId], globalThis);
    const ops: Promise<void>[] = [];
    const hydrated = await hydrateStepArguments(
      dehydrated,
      ops,
      mockRunId,
      globalThis
    );
    const result = hydrated[0];

    expect(result).toBe(stepFn);
  });

  it('should throw error when reviver cannot find registered step function', async () => {
    // Create a function with a non-existent stepId
    const fnWithNonExistentStepId = async () => 42;
    Object.defineProperty(fnWithNonExistentStepId, 'stepId', {
      value: 'nonExistentStep',
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Serialize the step function reference
    const dehydrated = await dehydrateStepArguments(
      [fnWithNonExistentStepId],
      globalThis
    );

    // Hydrating should throw an error
    const ops: Promise<void>[] = [];
    let err: Error | undefined;
    try {
      await hydrateStepArguments(dehydrated, ops, mockRunId, globalThis);
    } catch (err_) {
      err = err_ as Error;
    }

    expect(err).toBeDefined();
    expect(err?.message).toContain('Step function "nonExistentStep" not found');
    expect(err?.message).toContain('Make sure the step function is registered');
  });

  it('should dehydrate step function passed as argument to a step', async () => {
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
    const dehydrated = await dehydrateStepArguments(args, globalThis);

    // Verify it dehydrated successfully
    expect(dehydrated).toBeDefined();
    expect(dehydrated instanceof Uint8Array).toBe(true);
    // The dehydrated structure is a binary format from devalue
    // It should contain the step function serialized as its name
    const dehydratedStr = new TextDecoder().decode(dehydrated);
    expect(dehydratedStr).toContain(stepName);
    expect(dehydratedStr).toContain('42');
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
    const dehydrated = await dehydrateStepArguments(args, globalThis);

    // Verify it serialized
    expect(dehydrated).toBeDefined();
    expect(dehydrated instanceof Uint8Array).toBe(true);
    const serialized = new TextDecoder().decode(dehydrated);
    expect(serialized).toContain(stepName);
    expect(serialized).toContain('multiplier');
    expect(serialized).toContain('prefix');

    // Now hydrate it back
    const hydrated = await hydrateStepArguments(
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

  it('should hydrate step function from workflow arguments using WORKFLOW_USE_STEP', async () => {
    // This tests the flow: client mode serializes step function with stepId,
    // workflow mode deserializes it using WORKFLOW_USE_STEP from vmGlobalThis
    const stepId = 'step//workflows/test.ts//addNumbers';

    // Create a VM context like the workflow runner does
    const { context, globalThis: vmGlobalThis } = createContext({
      seed: 'test',
      fixedTimestamp: 1714857600000,
    });

    // Set up WORKFLOW_USE_STEP on the VM's globalThis (like workflow.ts does)
    const mockUseStep = (id: string) => {
      const fn = (...args: any[]) => {
        // Return a promise that resolves with args (like useStep wrapper does)
        return Promise.resolve({ calledWithStepId: id, args });
      };
      fn.stepId = id;
      return fn;
    };
    (vmGlobalThis as any)[Symbol.for('WORKFLOW_USE_STEP')] = mockUseStep;

    // Create a function with stepId (like SWC plugin does in client mode)
    const clientStepFn = async (a: number, b: number) => a + b;
    Object.defineProperty(clientStepFn, 'stepId', {
      value: stepId,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Serialize from client side using external reducers
    const ops: Promise<void>[] = [];
    const dehydrated = await dehydrateWorkflowArguments(
      [clientStepFn, 3, 5],
      ops,
      mockRunId,
      globalThis
    );

    // Hydrate in workflow context using VM's globalThis
    const hydrated = await hydrateWorkflowArguments(dehydrated, vmGlobalThis);

    // Verify the hydrated result
    expect(Array.isArray(hydrated)).toBe(true);
    expect(hydrated).toHaveLength(3);

    const [hydratedStepFn, arg1, arg2] = hydrated;

    // The step function should be a function (from useStep wrapper)
    expect(typeof hydratedStepFn).toBe('function');
    expect(arg1).toBe(3);
    expect(arg2).toBe(5);

    // The hydrated function should have stepId
    expect(hydratedStepFn.stepId).toBe(stepId);
  });

  it('should throw error when WORKFLOW_USE_STEP is not set on globalThis', async () => {
    const stepId = 'step//workflows/test.ts//missingUseStep';

    // Create a VM context WITHOUT setting up WORKFLOW_USE_STEP
    const { context, globalThis: vmGlobalThis } = createContext({
      seed: 'test',
      fixedTimestamp: 1714857600000,
    });

    // Create a function with stepId
    const clientStepFn = async (a: number, b: number) => a + b;
    Object.defineProperty(clientStepFn, 'stepId', {
      value: stepId,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Serialize from client side
    const ops: Promise<void>[] = [];
    const dehydrated = await dehydrateWorkflowArguments(
      [clientStepFn],
      ops,
      mockRunId,
      globalThis
    );

    // Hydrating should throw because WORKFLOW_USE_STEP is not set
    await expect(
      hydrateWorkflowArguments(dehydrated, vmGlobalThis)
    ).rejects.toThrow('WORKFLOW_USE_STEP not found on global object');
  });
});

describe('custom class serialization', () => {
  const { context, globalThis: vmGlobalThis } = createContext({
    seed: 'test',
    fixedTimestamp: 1714857600000,
  });

  // Make the serialization symbols available inside the VM
  (vmGlobalThis as any).WORKFLOW_SERIALIZE = WORKFLOW_SERIALIZE;
  (vmGlobalThis as any).WORKFLOW_DESERIALIZE = WORKFLOW_DESERIALIZE;

  // Define registerSerializationClass inside the VM so that it uses the VM's globalThis.
  // In production, the workflow bundle includes the full function code, so globalThis
  // inside it refers to the VM's global. We simulate that here.
  runInContext(
    `
    const WORKFLOW_CLASS_REGISTRY = Symbol.for('workflow-class-registry');
    function registerSerializationClass(classId, cls) {
      let registry = globalThis[WORKFLOW_CLASS_REGISTRY];
      if (!registry) {
        registry = new Map();
        globalThis[WORKFLOW_CLASS_REGISTRY] = registry;
      }
      registry.set(classId, cls);
      Object.defineProperty(cls, 'classId', {
        value: classId,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }
    globalThis.registerSerializationClass = registerSerializationClass;
    `,
    context
  );

  it('should serialize and deserialize a class with WORKFLOW_SERIALIZE/DESERIALIZE', async () => {
    // Define the class in the host context (for serialization)
    class Point {
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

    // The classId is normally generated by the SWC compiler
    (Point as any).classId = 'test/Point';

    // Register the class on the host for serialization
    registerSerializationClass('test/Point', Point);

    // Define and register the class inside the VM (simulates workflow bundle)
    // In production, the SWC plugin generates this code in the workflow bundle
    runInContext(
      `
      class Point {
        constructor(x, y) {
          this.x = x;
          this.y = y;
        }
        static [WORKFLOW_SERIALIZE](instance) {
          return { x: instance.x, y: instance.y };
        }
        static [WORKFLOW_DESERIALIZE](data) {
          return new Point(data.x, data.y);
        }
      }
      Point.classId = 'test/Point';
      registerSerializationClass('test/Point', Point);
      `,
      context
    );

    const point = new Point(10, 20);
    const serialized = await dehydrateWorkflowArguments(point, [], mockRunId);

    // Verify it serialized with the Instance type
    expect(serialized).toBeDefined();
    expect(serialized instanceof Uint8Array).toBe(true);
    // Check that the serialized data contains the classId
    const serializedStr = new TextDecoder().decode(serialized);
    expect(serializedStr).toContain('test/Point');

    // Hydrate it back (inside the VM context)
    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);
    // Note: hydrated is an instance of the VM's Point class, not the host's
    // so we check constructor.name instead of instanceof
    expect(hydrated.constructor.name).toBe('Point');
    expect(hydrated.x).toBe(10);
    expect(hydrated.y).toBe(20);
  });

  it('should serialize nested custom serializable objects', async () => {
    // Define the class in the host context (for serialization)
    class Vector {
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

    // The classId is normally generated by the SWC compiler
    (Vector as any).classId = 'test/Vector';

    // Register the class on the host for serialization
    registerSerializationClass('test/Vector', Vector);

    // Define and register the class inside the VM
    runInContext(
      `
      class Vector {
        constructor(dx, dy) {
          this.dx = dx;
          this.dy = dy;
        }
        static [WORKFLOW_SERIALIZE](instance) {
          return { dx: instance.dx, dy: instance.dy };
        }
        static [WORKFLOW_DESERIALIZE](data) {
          return new Vector(data.dx, data.dy);
        }
      }
      Vector.classId = 'test/Vector';
      registerSerializationClass('test/Vector', Vector);
      `,
      context
    );

    const data = {
      name: 'test',
      vector: new Vector(5, 10),
      nested: {
        anotherVector: new Vector(1, 2),
      },
    };

    const serialized = await dehydrateWorkflowArguments(data, [], mockRunId);
    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);

    expect(hydrated.name).toBe('test');
    expect(hydrated.vector.constructor.name).toBe('Vector');
    expect(hydrated.vector.dx).toBe(5);
    expect(hydrated.vector.dy).toBe(10);
    expect(hydrated.nested.anotherVector.constructor.name).toBe('Vector');
    expect(hydrated.nested.anotherVector.dx).toBe(1);
    expect(hydrated.nested.anotherVector.dy).toBe(2);
  });

  it('should serialize custom class in an array', async () => {
    // Define the class in the host context (for serialization)
    class Item {
      constructor(public id: string) {}

      static [WORKFLOW_SERIALIZE](instance: Item) {
        return { id: instance.id };
      }

      static [WORKFLOW_DESERIALIZE](data: { id: string }) {
        return new Item(data.id);
      }
    }

    // The classId is normally generated by the SWC compiler
    (Item as any).classId = 'test/Item';

    // Register the class on the host for serialization
    registerSerializationClass('test/Item', Item);

    // Define and register the class inside the VM
    runInContext(
      `
      class Item {
        constructor(id) {
          this.id = id;
        }
        static [WORKFLOW_SERIALIZE](instance) {
          return { id: instance.id };
        }
        static [WORKFLOW_DESERIALIZE](data) {
          return new Item(data.id);
        }
      }
      Item.classId = 'test/Item';
      registerSerializationClass('test/Item', Item);
      `,
      context
    );

    const items = [new Item('a'), new Item('b'), new Item('c')];

    const serialized = await dehydrateWorkflowArguments(items, [], mockRunId);
    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);

    expect(Array.isArray(hydrated)).toBe(true);
    expect(hydrated).toHaveLength(3);
    expect(hydrated[0].constructor.name).toBe('Item');
    expect(hydrated[0].id).toBe('a');
    expect(hydrated[1].constructor.name).toBe('Item');
    expect(hydrated[1].id).toBe('b');
    expect(hydrated[2].constructor.name).toBe('Item');
    expect(hydrated[2].id).toBe('c');
  });

  it('should work with step arguments', async () => {
    class Config {
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

    // The classId is normally generated by the SWC compiler
    (Config as any).classId = 'test/Config';

    // Register the class for deserialization
    registerSerializationClass('test/Config', Config);

    const config = new Config('maxRetries', 3);
    const serialized = await dehydrateStepArguments([config], globalThis);
    const hydrated = await hydrateStepArguments(
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

  it('should work with step return values', async () => {
    class Result {
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

    // The classId is normally generated by the SWC compiler
    (Result as any).classId = 'test/Result';

    // Register the class for deserialization
    registerSerializationClass('test/Result', Result);

    const result = new Result(true, 'completed');
    const serialized = await dehydrateStepReturnValue(result, [], mockRunId);
    // Step return values are hydrated with workflow revivers
    const hydrated = await hydrateWorkflowArguments(serialized, globalThis);

    expect(hydrated).toBeInstanceOf(Result);
    expect(hydrated.success).toBe(true);
    expect(hydrated.data).toBe('completed');
  });

  it('should not serialize classes without WORKFLOW_SERIALIZE', async () => {
    class PlainClass {
      constructor(public value: string) {}
    }

    const instance = new PlainClass('test');

    // Should throw because PlainClass is not serializable
    await expect(
      dehydrateWorkflowArguments(instance, [], mockRunId)
    ).rejects.toThrow();
  });

  it('should throw error when classId is missing', async () => {
    // NOTE: Missing `classId` property so serializatoin will fail.
    class NoClassId {
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
      await dehydrateWorkflowArguments(instance, [], mockRunId);
    } catch (e: any) {
      errorMessage = e.cause?.message || e.message;
    }
    expect(errorMessage).toMatch(/must have a static "classId" property/);
  });

  it('should serialize class with complex data types in payload', async () => {
    class ComplexData {
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

    // The classId is normally generated by the SWC compiler
    (ComplexData as any).classId = 'test/ComplexData';

    // Register the class for deserialization
    registerSerializationClass('test/ComplexData', ComplexData);

    const map = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const date = new Date('2025-01-01T00:00:00.000Z');
    const complex = new ComplexData(map, date);

    const serialized = await dehydrateWorkflowArguments(complex, [], mockRunId);
    const hydrated = await hydrateWorkflowArguments(serialized, globalThis);

    expect(hydrated).toBeInstanceOf(ComplexData);
    expect(hydrated.items).toBeInstanceOf(Map);
    expect(hydrated.items.get('a')).toBe(1);
    expect(hydrated.items.get('b')).toBe(2);
    expect(hydrated.created).toBeInstanceOf(Date);
    expect(hydrated.created.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('should pass class as this context to WORKFLOW_SERIALIZE and WORKFLOW_DESERIALIZE', async () => {
    // This test verifies that serialize.call(cls, value) and deserialize.call(cls, data)
    // properly pass the class as `this` context, which is required when the serializer/deserializer
    // needs to access static properties or methods on the class

    class Counter {
      // Static property that the serializer uses via `this`
      static serializedCount = 0;
      static deserializedCount = 0;

      constructor(public value: number) {}

      static [WORKFLOW_SERIALIZE](this: typeof Counter, instance: Counter) {
        // biome-ignore lint/complexity/noThisInStatic: intentionally testing `this` context binding
        this.serializedCount++;
        // biome-ignore lint/complexity/noThisInStatic: intentionally testing `this` context binding
        return { value: instance.value, serializedAt: this.serializedCount };
      }

      static [WORKFLOW_DESERIALIZE](
        this: typeof Counter,
        data: { value: number; serializedAt: number }
      ) {
        // biome-ignore lint/complexity/noThisInStatic: intentionally testing `this` context binding
        this.deserializedCount++;
        return new Counter(data.value);
      }
    }

    // The classId is normally generated by the SWC compiler
    (Counter as any).classId = 'test/Counter';

    // Register the class for serialization/deserialization
    registerSerializationClass('test/Counter', Counter);

    // Reset counters
    Counter.serializedCount = 0;
    Counter.deserializedCount = 0;

    // Serialize an instance - this should increment serializedCount via `this`
    const counter = new Counter(42);
    const serialized = await dehydrateWorkflowArguments(counter, [], mockRunId);

    // Verify serialization used `this` correctly
    expect(Counter.serializedCount).toBe(1);

    // Deserialize - this should increment deserializedCount via `this`
    const hydrated = await hydrateWorkflowArguments(serialized, globalThis);

    // Verify deserialization used `this` correctly
    expect(Counter.deserializedCount).toBe(1);
    expect(hydrated).toBeInstanceOf(Counter);
    expect(hydrated.value).toBe(42);

    // Serialize another instance to verify counter increments
    const counter2 = new Counter(100);
    await dehydrateWorkflowArguments(counter2, [], mockRunId);
    expect(Counter.serializedCount).toBe(2);
  });
});

describe('format prefix system', () => {
  const { globalThis: vmGlobalThis } = createContext({
    seed: 'test',
    fixedTimestamp: 1714857600000,
  });

  it('should encode data with format prefix', async () => {
    const data = { message: 'hello' };
    const serialized = await dehydrateWorkflowArguments(data, [], mockRunId);

    // Check that the first 4 bytes are the format prefix "devl"
    const prefix = new TextDecoder().decode(serialized.subarray(0, 4));
    expect(prefix).toBe('devl');
  });

  it('should decode prefixed data correctly', async () => {
    const data = { message: 'hello', count: 42 };
    const serialized = await dehydrateWorkflowArguments(data, [], mockRunId);
    const hydrated = await hydrateWorkflowArguments(serialized, vmGlobalThis);

    expect(hydrated).toEqual({ message: 'hello', count: 42 });
  });

  it('should handle all dehydrate/hydrate function pairs with format prefix', async () => {
    const testData = { test: 'data', nested: { value: 123 } };

    // Workflow arguments
    const workflowArgs = await dehydrateWorkflowArguments(
      testData,
      [],
      mockRunId
    );
    expect(new TextDecoder().decode(workflowArgs.subarray(0, 4))).toBe('devl');
    expect(await hydrateWorkflowArguments(workflowArgs, vmGlobalThis)).toEqual(
      testData
    );

    // Workflow return value
    const workflowReturn = await dehydrateWorkflowReturnValue(
      testData,
      globalThis
    );
    expect(new TextDecoder().decode(workflowReturn.subarray(0, 4))).toBe(
      'devl'
    );
    expect(
      await hydrateWorkflowReturnValue(
        workflowReturn,
        [],
        mockRunId,
        vmGlobalThis
      )
    ).toEqual(testData);

    // Step arguments
    const stepArgs = await dehydrateStepArguments(testData, globalThis);
    expect(new TextDecoder().decode(stepArgs.subarray(0, 4))).toBe('devl');
    expect(
      await hydrateStepArguments(stepArgs, [], mockRunId, vmGlobalThis)
    ).toEqual(testData);

    // Step return value
    const stepReturn = await dehydrateStepReturnValue(testData, [], mockRunId);
    expect(new TextDecoder().decode(stepReturn.subarray(0, 4))).toBe('devl');
    expect(await hydrateStepReturnValue(stepReturn, vmGlobalThis)).toEqual(
      testData
    );
  });

  it('should throw error for unknown format prefix', async () => {
    // Create data with an unknown 4-character format prefix
    const unknownFormat = new TextEncoder().encode('unkn{"test":true}');

    await expect(
      hydrateWorkflowArguments(unknownFormat, vmGlobalThis)
    ).rejects.toThrow(/Unknown serialization format/);
  });

  it('should throw error for data too short to contain format prefix', async () => {
    const tooShort = new TextEncoder().encode('dev');

    await expect(
      hydrateWorkflowArguments(tooShort, vmGlobalThis)
    ).rejects.toThrow(/Data too short to contain format prefix/);
  });
});

describe('decodeFormatPrefix legacy compatibility', () => {
  it('should handle legacy object data (non-Uint8Array)', () => {
    const legacyData = { message: 'hello', count: 42 };
    const result = decodeFormatPrefix(legacyData);

    expect(result.format).toBe(SerializationFormat.DEVALUE_V1);
    expect(result.payload).toBeInstanceOf(Uint8Array);

    // The payload should be JSON-encoded
    const decoded = new TextDecoder().decode(result.payload);
    expect(JSON.parse(decoded)).toEqual(legacyData);
  });

  it('should handle legacy array data (non-Uint8Array)', () => {
    const legacyData = [1, 2, 'three', { nested: true }];
    const result = decodeFormatPrefix(legacyData);

    expect(result.format).toBe(SerializationFormat.DEVALUE_V1);
    expect(result.payload).toBeInstanceOf(Uint8Array);

    const decoded = new TextDecoder().decode(result.payload);
    expect(JSON.parse(decoded)).toEqual(legacyData);
  });

  it('should handle legacy undefined data (non-Uint8Array)', () => {
    const legacyData = undefined;
    const result = decodeFormatPrefix(legacyData);

    expect(result.format).toBe(SerializationFormat.DEVALUE_V1);
    expect(result.payload).toBeInstanceOf(Uint8Array);

    // JSON.stringify(undefined) returns undefined (not a string),
    // which when encoded produces an empty Uint8Array
    expect(result.payload.length).toBe(0);
  });

  it('should still correctly handle v2 Uint8Array data', () => {
    // Create valid v2 data with 'devl' prefix
    const payload = new TextEncoder().encode('["test"]');
    const v2Data = new Uint8Array(4 + payload.length);
    v2Data.set(new TextEncoder().encode('devl'), 0);
    v2Data.set(payload, 4);

    const result = decodeFormatPrefix(v2Data);

    expect(result.format).toBe(SerializationFormat.DEVALUE_V1);
    expect(result.payload).toBeInstanceOf(Uint8Array);

    const decoded = new TextDecoder().decode(result.payload);
    expect(decoded).toBe('["test"]');
  });
});

// ---------------------------------------------------------------------------
// getSerializeStream / getDeserializeStream
// ---------------------------------------------------------------------------

describe('getSerializeStream', () => {
  // Empty reducers work for plain JSON-compatible values
  const reducers = {} as any;

  /** Write values and collect output concurrently (avoids backpressure deadlock) */
  async function serializeValues(values: unknown[]): Promise<Uint8Array[]> {
    const serialize = getSerializeStream(reducers);
    const results: Uint8Array[] = [];

    // Start reading before writing to avoid backpressure deadlock
    const readPromise = (async () => {
      const reader = serialize.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        results.push(value);
      }
    })();

    const writer = serialize.writable.getWriter();
    for (const value of values) {
      await writer.write(value);
    }
    await writer.close();
    await readPromise;
    return results;
  }

  /** Feed Uint8Array chunks into a deserialize stream and collect results */
  async function deserializeChunks(
    chunks: Uint8Array[],
    revivers: any
  ): Promise<unknown[]> {
    const deserialize = getDeserializeStream(revivers);
    const results: unknown[] = [];

    const readPromise = (async () => {
      const reader = deserialize.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        results.push(value);
      }
    })();

    const writer = deserialize.writable.getWriter();
    for (const chunk of chunks) {
      await writer.write(chunk);
    }
    await writer.close();
    await readPromise;
    return results;
  }

  it('should serialize each chunk with format prefix and length framing', async () => {
    const chunks = await serializeValues([{ hello: 'world' }, 42]);
    expect(chunks).toHaveLength(2);

    for (const chunk of chunks) {
      expect(chunk).toBeInstanceOf(Uint8Array);
      // Each chunk should be: [4-byte length][devl...payload...]
      expect(chunk.length).toBeGreaterThan(8); // 4 header + 4 prefix + payload

      // Read the length header
      const view = new DataView(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength
      );
      const frameLength = view.getUint32(0, false);
      expect(frameLength).toBe(chunk.length - 4);

      // Read the format prefix
      const prefix = new TextDecoder().decode(chunk.subarray(4, 8));
      expect(prefix).toBe('devl');
    }
  });

  it('should produce chunks that getDeserializeStream can parse', async () => {
    const revivers = getCommonRevivers(globalThis) as any;
    const original = [
      { message: 'hello', count: 42 },
      [1, 2, 3],
      'plain string',
      null,
    ];

    const serialized = await serializeValues(original);
    const results = await deserializeChunks(serialized, revivers);

    expect(results).toHaveLength(4);
    expect(results[0]).toEqual({ message: 'hello', count: 42 });
    expect(results[1]).toEqual([1, 2, 3]);
    expect(results[2]).toBe('plain string');
    expect(results[3]).toBe(null);
  });

  it('should handle deserializing when chunks are concatenated', async () => {
    const revivers = getCommonRevivers(globalThis) as any;
    const serialized = await serializeValues([{ a: 1 }, { b: 2 }, { c: 3 }]);

    // Concatenate all chunks into a single Uint8Array (simulates
    // transport coalescing multiple chunks into one read)
    const totalLength = serialized.reduce((sum, c) => sum + c.length, 0);
    const concatenated = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of serialized) {
      concatenated.set(chunk, offset);
      offset += chunk.length;
    }

    const results = await deserializeChunks([concatenated], revivers);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ a: 1 });
    expect(results[1]).toEqual({ b: 2 });
    expect(results[2]).toEqual({ c: 3 });
  });

  it('should handle deserializing when chunks are split arbitrarily', async () => {
    const revivers = getCommonRevivers(globalThis) as any;
    const serialized = await serializeValues([{ key: 'value' }]);
    const fullData = serialized[0];

    // Split the chunk at an arbitrary point (in the middle of the frame)
    const splitPoint = Math.floor(fullData.length / 2);
    const part1 = fullData.slice(0, splitPoint);
    const part2 = fullData.slice(splitPoint);

    const results = await deserializeChunks([part1, part2], revivers);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ key: 'value' });
  });
});

describe('getDeserializeStream legacy fallback', () => {
  const revivers = getCommonRevivers(globalThis) as any;

  /** Feed Uint8Array chunks into a deserialize stream and collect results */
  async function deserializeChunks(chunks: Uint8Array[]): Promise<unknown[]> {
    const deserialize = getDeserializeStream(revivers);
    const results: unknown[] = [];

    const readPromise = (async () => {
      const reader = deserialize.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        results.push(value);
      }
    })();

    const writer = deserialize.writable.getWriter();
    for (const chunk of chunks) {
      await writer.write(chunk);
    }
    await writer.close();
    await readPromise;
    return results;
  }

  it('should parse legacy newline-delimited devalue text', async () => {
    const { stringify } = await import('devalue');
    const encoder = new TextEncoder();

    const line1 = stringify({ hello: 'world' }) + '\n';
    const line2 = stringify(42) + '\n';
    const legacyData = encoder.encode(line1 + line2);

    const results = await deserializeChunks([legacyData]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ hello: 'world' });
    expect(results[1]).toBe(42);
  });

  it('should parse legacy single-line chunks', async () => {
    const { stringify } = await import('devalue');
    const encoder = new TextEncoder();

    const chunk1 = encoder.encode(stringify('hello') + '\n');
    const chunk2 = encoder.encode(stringify('world') + '\n');

    const results = await deserializeChunks([chunk1, chunk2]);
    expect(results).toHaveLength(2);
    expect(results[0]).toBe('hello');
    expect(results[1]).toBe('world');
  });
});
