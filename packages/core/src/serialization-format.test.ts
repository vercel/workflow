import { stringify } from 'devalue';
import { describe, expect, it } from 'vitest';
import {
  ClassInstanceRef,
  decodeFormatPrefix,
  encodeWithFormatPrefix,
  extractStreamIds,
  hydrateData,
  hydrateResourceIO,
  isClassInstanceRef,
  isStreamId,
  isStreamRef,
  observabilityRevivers,
  type Revivers,
  SerializationFormat,
  STREAM_REF_TYPE,
  truncateId,
} from './serialization-format.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a v2 binary payload: "devl" prefix + devalue stringify */
function makeDevlPayload(value: unknown, revivers?: Revivers): Uint8Array {
  const text = stringify(value, revivers);
  const textBytes = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(SerializationFormat.DEVALUE_V1);
  const result = new Uint8Array(prefix.length + textBytes.length);
  result.set(prefix, 0);
  result.set(textBytes, prefix.length);
  return result;
}

/** Minimal revivers that handle basic types (no Node.js dependencies) */
const testRevivers: Revivers = {
  ...observabilityRevivers,
  Date: (value) => new Date(value),
  Error: (value) => {
    const error = new Error(value.message);
    error.name = value.name;
    return error;
  },
  Map: (value) => new Map(value),
  Set: (value) => new Set(value),
  RegExp: (value) => new RegExp(value.source, value.flags),
  URL: (value) => new URL(value),
  URLSearchParams: (value) => new URLSearchParams(value === '.' ? '' : value),
};

// ---------------------------------------------------------------------------
// encodeWithFormatPrefix / decodeFormatPrefix
// ---------------------------------------------------------------------------

describe('encodeWithFormatPrefix', () => {
  it('should prepend the format prefix to a Uint8Array payload', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const encoded = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBe(4 + 3); // "devl" (4 bytes) + payload (3 bytes)

    const prefix = new TextDecoder().decode(encoded.subarray(0, 4));
    expect(prefix).toBe('devl');
    expect(Array.from(encoded.subarray(4))).toEqual([1, 2, 3]);
  });

  it('should pass through non-Uint8Array values', () => {
    const result = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      'hello'
    );
    expect(result).toBe('hello');
  });
});

describe('decodeFormatPrefix', () => {
  it('should decode a valid devl-prefixed Uint8Array', () => {
    const payload = new Uint8Array([10, 20, 30]);
    const encoded = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;

    const { format, payload: decoded } = decodeFormatPrefix(encoded);
    expect(format).toBe('devl');
    expect(Array.from(decoded)).toEqual([10, 20, 30]);
  });

  it('should throw for data shorter than the prefix length', () => {
    expect(() => decodeFormatPrefix(new Uint8Array([1, 2]))).toThrow(
      'Data too short'
    );
  });

  it('should throw for unknown format prefix', () => {
    const unknown = new TextEncoder().encode('zzzz1234');
    expect(() => decodeFormatPrefix(unknown)).toThrow(
      'Unknown serialization format'
    );
  });
});

// ---------------------------------------------------------------------------
// hydrateData
// ---------------------------------------------------------------------------

describe('hydrateData', () => {
  it('should parse a devl-prefixed Uint8Array with devalue', () => {
    const original = { greeting: 'hello', count: 42 };
    const encoded = makeDevlPayload(original);

    const result = hydrateData(encoded, testRevivers);
    expect(result).toEqual(original);
  });

  it('should unflatten a legacy array (specVersion 1)', () => {
    // Legacy format: the result of devalue's flatten()
    // For a simple string, devalue produces [0, "hello"]
    // But more commonly it's an array of values
    const legacyArray = [{ greeting: 1 }, 'hello'];
    const result = hydrateData(legacyArray, testRevivers);
    expect(result).toEqual({ greeting: 'hello' });
  });

  it('should pass through plain values (string, number, null)', () => {
    expect(hydrateData('hello', testRevivers)).toBe('hello');
    expect(hydrateData(42, testRevivers)).toBe(42);
    expect(hydrateData(null, testRevivers)).toBe(null);
    expect(hydrateData(undefined, testRevivers)).toBe(undefined);
  });

  it('should apply custom revivers during parsing', () => {
    // Create a devl payload containing a Date (devalue handles Date natively
    // by using a "Date" type with the ISO string as the value)
    const original = { timestamp: new Date('2026-01-15T12:00:00Z') };
    const encoded = makeDevlPayload(original);

    const result = hydrateData(encoded, testRevivers) as {
      timestamp: Date;
    };
    expect(result.timestamp).toBeInstanceOf(Date);
    expect(result.timestamp.toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });

  it('should throw for unsupported format prefix', () => {
    const fakePrefix = new TextEncoder().encode('fake');
    const payload = new TextEncoder().encode('{}');
    const data = new Uint8Array(fakePrefix.length + payload.length);
    data.set(fakePrefix, 0);
    data.set(payload, fakePrefix.length);

    expect(() => hydrateData(data, testRevivers)).toThrow(
      'Unknown serialization format'
    );
  });
});

// ---------------------------------------------------------------------------
// hydrateResourceIO
// ---------------------------------------------------------------------------

describe('hydrateResourceIO', () => {
  it('should hydrate step input and output', () => {
    const input = makeDevlPayload({ args: ['hello'] });
    const output = makeDevlPayload({ result: 42 });

    const step = {
      stepId: 'step_123',
      input,
      output,
    };

    const hydrated = hydrateResourceIO(step, testRevivers);
    expect(hydrated.stepId).toBe('step_123');
    expect(hydrated.input).toEqual({ args: ['hello'] });
    expect(hydrated.output).toEqual({ result: 42 });
  });

  it('should hydrate workflow run input and output', () => {
    const input = makeDevlPayload('user@example.com');
    const output = makeDevlPayload({ status: 'completed' });

    const run = {
      runId: 'wrun_123',
      input,
      output,
    };

    const hydrated = hydrateResourceIO(run, testRevivers);
    expect(hydrated.runId).toBe('wrun_123');
    expect(hydrated.input).toBe('user@example.com');
    expect(hydrated.output).toEqual({ status: 'completed' });
  });

  it('should hydrate event eventData.result', () => {
    const resultPayload = makeDevlPayload({ key: 'value' });

    const event = {
      eventId: 'evt_123',
      eventData: {
        type: 'step_completed',
        result: resultPayload,
      },
    };

    const hydrated = hydrateResourceIO(event, testRevivers);
    expect(hydrated.eventId).toBe('evt_123');
    expect(hydrated.eventData.result).toEqual({ key: 'value' });
    expect(hydrated.eventData.type).toBe('step_completed');
  });

  it('should hydrate event eventData.output', () => {
    const outputPayload = makeDevlPayload({ message: 'done' });

    const event = {
      eventId: 'evt_456',
      eventData: {
        type: 'run_completed',
        output: outputPayload,
      },
    };

    const hydrated = hydrateResourceIO(event, testRevivers);
    expect(hydrated.eventId).toBe('evt_456');
    expect(hydrated.eventData.output).toEqual({ message: 'done' });
    expect(hydrated.eventData.type).toBe('run_completed');
  });

  it('should hydrate event eventData.metadata for hook_created events', () => {
    const metadataPayload = makeDevlPayload({ source: 'webhook', retries: 2 });

    const event = {
      eventId: 'evt_hook_created',
      eventData: {
        type: 'hook_created',
        token: 'hook_tok_123',
        metadata: metadataPayload,
      },
    };

    const hydrated = hydrateResourceIO(event, testRevivers);
    expect(hydrated.eventId).toBe('evt_hook_created');
    expect(hydrated.eventData.metadata).toEqual({
      source: 'webhook',
      retries: 2,
    });
    expect(hydrated.eventData.token).toBe('hook_tok_123');
  });

  it('should hydrate event eventData.payload for hook_received events', () => {
    const payload = makeDevlPayload({ hello: 'world', count: 7 });

    const event = {
      eventId: 'evt_hook_received',
      eventData: {
        type: 'hook_received',
        payload,
      },
    };

    const hydrated = hydrateResourceIO(event, testRevivers);
    expect(hydrated.eventId).toBe('evt_hook_received');
    expect(hydrated.eventData.payload).toEqual({ hello: 'world', count: 7 });
  });

  it('should hydrate hook metadata', () => {
    const metadata = makeDevlPayload({ token: 'abc123' });

    const hook = {
      hookId: 'hook_123',
      metadata,
    };

    const hydrated = hydrateResourceIO(hook, testRevivers);
    expect(hydrated.hookId).toBe('hook_123');
    expect(hydrated.metadata).toEqual({ token: 'abc123' });
  });

  it('should handle null/undefined fields gracefully', () => {
    const step = {
      stepId: 'step_456',
      input: null,
      output: undefined,
    };

    const hydrated = hydrateResourceIO(step, testRevivers);
    expect(hydrated.input).toBe(null);
    expect(hydrated.output).toBe(undefined);
  });

  it('should strip executionContext and preserve workflowCoreVersion', () => {
    const run = {
      runId: 'wrun_789',
      executionContext: {
        workflowCoreVersion: '4.1.0',
        otherStuff: 'should be removed',
      },
    };

    const hydrated = hydrateResourceIO(run, testRevivers);
    expect(hydrated.executionContext).toBeUndefined();
    expect((hydrated as any).workflowCoreVersion).toBe('4.1.0');
  });

  it('should leave data un-hydrated on parse errors', () => {
    // Create a Uint8Array with valid prefix but garbage devalue content
    const prefix = new TextEncoder().encode('devl');
    const garbage = new TextEncoder().encode('not valid devalue');
    const data = new Uint8Array(prefix.length + garbage.length);
    data.set(prefix, 0);
    data.set(garbage, prefix.length);

    const step = { stepId: 'step_err', input: data };
    const hydrated = hydrateResourceIO(step, testRevivers);

    // Should return the raw Uint8Array instead of crashing
    expect(hydrated.input).toBeInstanceOf(Uint8Array);
  });

  it('should return null/undefined resources as-is', () => {
    expect(hydrateResourceIO(null as any, testRevivers)).toBe(null);
    expect(hydrateResourceIO(undefined as any, testRevivers)).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// observabilityRevivers
// ---------------------------------------------------------------------------

describe('observabilityRevivers', () => {
  it('should convert ReadableStream to StreamRef', () => {
    const ref = observabilityRevivers.ReadableStream({
      name: 'strm_abc123',
    });
    expect(isStreamRef(ref)).toBe(true);
    expect(ref.streamId).toBe('strm_abc123');
  });

  it('should convert StepFunction to display string', () => {
    const result = observabilityRevivers.StepFunction({
      stepId: 'step_xyz',
    });
    expect(result).toBe('<step:step_xyz>');
  });

  it('should convert Instance to ClassInstanceRef', () => {
    const result = observabilityRevivers.Instance({
      classId: 'pkg//MyClass',
      data: { x: 1 },
    });
    expect(isClassInstanceRef(result)).toBe(true);
    expect((result as ClassInstanceRef).className).toBe('MyClass');
    expect((result as ClassInstanceRef).data).toEqual({ x: 1 });
  });

  it('should convert Class to display string', () => {
    const result = observabilityRevivers.Class({
      classId: 'pkg//MyClass',
    });
    expect(result).toBe('<class:MyClass>');
  });
});

// ---------------------------------------------------------------------------
// isStreamRef / isStreamId / extractStreamIds / truncateId
// (ported from observability.test.ts)
// ---------------------------------------------------------------------------

describe('isStreamRef', () => {
  it('should return true for valid StreamRef', () => {
    const streamRef = {
      __type: STREAM_REF_TYPE,
      streamId: 'strm_123',
    };
    expect(isStreamRef(streamRef)).toBe(true);
  });

  it('should return false for null', () => {
    expect(isStreamRef(null)).toBe(false);
  });

  it('should return false for wrong __type', () => {
    expect(isStreamRef({ __type: 'wrong', streamId: 'strm_123' })).toBe(false);
  });
});

describe('isStreamId', () => {
  it('should return true for valid stream ID', () => {
    expect(isStreamId('strm_abc123')).toBe(true);
  });

  it('should return false for non-stream strings', () => {
    expect(isStreamId('not_a_stream')).toBe(false);
  });

  it('should return false for non-strings', () => {
    expect(isStreamId(123)).toBe(false);
    expect(isStreamId(null)).toBe(false);
    expect(isStreamId({})).toBe(false);
  });
});

describe('extractStreamIds', () => {
  it('should extract stream IDs from flat objects', () => {
    const obj = { stream: 'strm_123', other: 'not_stream' };
    expect(extractStreamIds(obj)).toEqual(['strm_123']);
  });

  it('should extract stream IDs from nested objects', () => {
    const obj = {
      level1: {
        level2: {
          stream: 'strm_abc',
        },
      },
    };
    expect(extractStreamIds(obj)).toEqual(['strm_abc']);
  });

  it('should extract stream IDs from arrays', () => {
    const arr = ['strm_1', 'strm_2', 'not_stream'];
    expect(extractStreamIds(arr)).toEqual(['strm_1', 'strm_2']);
  });

  it('should deduplicate stream IDs', () => {
    const obj = { a: 'strm_same', b: 'strm_same' };
    expect(extractStreamIds(obj)).toEqual(['strm_same']);
  });

  it('should return empty array for no streams', () => {
    expect(extractStreamIds({ foo: 'bar' })).toEqual([]);
  });
});

describe('truncateId', () => {
  it('should not truncate short IDs', () => {
    expect(truncateId('short', 12)).toBe('short');
  });

  it('should truncate long IDs', () => {
    expect(truncateId('verylongidentifier', 12)).toBe('verylongiden...');
  });

  it('should use default max length of 12', () => {
    expect(truncateId('123456789012')).toBe('123456789012');
    expect(truncateId('1234567890123')).toBe('123456789012...');
  });
});

// ---------------------------------------------------------------------------
// hydrateResourceIO with custom class instances
// (ported from observability.test.ts)
// ---------------------------------------------------------------------------

describe('hydrateResourceIO with custom class instances', () => {
  it('should preserve ClassInstanceRef through JSON roundtrip', () => {
    const ref = new ClassInstanceRef('Point', 'class//Point', { x: 1, y: 2 });
    const json = JSON.stringify(ref);
    const parsed = JSON.parse(json);

    // After parsing, it's a plain object but still recognized
    expect(isClassInstanceRef(parsed)).toBe(true);
    expect(parsed.className).toBe('Point');
    expect(parsed.classId).toBe('class//Point');
    expect(parsed.data).toEqual({ x: 1, y: 2 });
  });
});
