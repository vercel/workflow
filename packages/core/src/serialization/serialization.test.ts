import { RuntimeDecryptionError } from '@workflow/errors';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import { describe, expect, it, vi } from 'vitest';
import { registerSerializationClass } from '../class-serialization.js';
import { importKey } from '../encryption.js';
import * as client from './client.js';
import { devalueCodec } from './codec-devalue.js';
import { decrypt, encrypt } from './encryption.js';
import {
  decodeFormatPrefix,
  encodeWithFormatPrefix,
  isEncrypted,
  peekFormatPrefix,
} from './format.js';
import { getClassReducers, getClassRevivers } from './reducers/class.js';
import { getCommonReducers, getCommonRevivers } from './reducers/common.js';
import {
  getStepFunctionReducer,
  getStepFunctionReviver,
} from './reducers/step-function.js';
import * as step from './step.js';
import { isFormatPrefix, SerializationFormat } from './types.js';
import * as workflow from './workflow.js';

// ---- Helper to create an encryption key ----

async function makeKey(): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  raw.fill(0x42);
  return importKey(raw);
}

// ============================================================================
// types.ts — FormatPrefix & SerializationFormat
// ============================================================================

describe('isFormatPrefix', () => {
  it('should accept valid 4-char lowercase alphanumeric strings', () => {
    expect(isFormatPrefix('devl')).toBe(true);
    expect(isFormatPrefix('cbor')).toBe(true);
    expect(isFormatPrefix('json')).toBe(true);
    expect(isFormatPrefix('encr')).toBe(true);
    expect(isFormatPrefix('abcd')).toBe(true);
    expect(isFormatPrefix('v2b1')).toBe(true);
    expect(isFormatPrefix('0000')).toBe(true);
    expect(isFormatPrefix('9999')).toBe(true);
    expect(isFormatPrefix('ab12')).toBe(true);
  });

  it('should reject strings that are too short', () => {
    expect(isFormatPrefix('')).toBe(false);
    expect(isFormatPrefix('a')).toBe(false);
    expect(isFormatPrefix('ab')).toBe(false);
    expect(isFormatPrefix('abc')).toBe(false);
  });

  it('should reject strings that are too long', () => {
    expect(isFormatPrefix('abcde')).toBe(false);
    expect(isFormatPrefix('abcdef')).toBe(false);
  });

  it('should reject uppercase characters', () => {
    expect(isFormatPrefix('DEVL')).toBe(false);
    expect(isFormatPrefix('Devl')).toBe(false);
    expect(isFormatPrefix('devL')).toBe(false);
  });

  it('should reject special characters', () => {
    expect(isFormatPrefix('de-l')).toBe(false);
    expect(isFormatPrefix('de_l')).toBe(false);
    expect(isFormatPrefix('de.l')).toBe(false);
    expect(isFormatPrefix('de l')).toBe(false);
  });

  it('should handle boundary alpha/numeric chars', () => {
    expect(isFormatPrefix('aaaa')).toBe(true);
    expect(isFormatPrefix('zzzz')).toBe(true);
    expect(isFormatPrefix('0000')).toBe(true);
    expect(isFormatPrefix('9999')).toBe(true);
    expect(isFormatPrefix('a0z9')).toBe(true);
  });
});

describe('SerializationFormat constants', () => {
  it('should have DEVALUE_V1 = "devl"', () => {
    expect(SerializationFormat.DEVALUE_V1).toBe('devl');
  });

  it('should have ENCRYPTED = "encr"', () => {
    expect(SerializationFormat.ENCRYPTED).toBe('encr');
  });

  it('all values should be valid format prefixes', () => {
    for (const value of Object.values(SerializationFormat)) {
      expect(isFormatPrefix(value)).toBe(true);
    }
  });
});

// ============================================================================
// format.ts — encodeWithFormatPrefix, decodeFormatPrefix, peekFormatPrefix, isEncrypted
// ============================================================================

describe('encodeWithFormatPrefix', () => {
  it('should prepend 4-byte prefix to payload', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const encoded = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;

    expect(encoded.length).toBe(4 + 3);
    // First 4 bytes should be 'devl'
    expect(new TextDecoder().decode(encoded.subarray(0, 4))).toBe('devl');
    // Remaining bytes should be the payload
    expect(Array.from(encoded.subarray(4))).toEqual([1, 2, 3]);
  });

  it('should return non-Uint8Array values unchanged', () => {
    const str = 'hello';
    expect(encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, str)).toBe(
      str
    );

    const num = 42;
    expect(encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, num)).toBe(
      num
    );

    expect(
      encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, null)
    ).toBeNull();
  });

  it('should handle empty payload', () => {
    const payload = new Uint8Array(0);
    const encoded = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;
    expect(encoded.length).toBe(4);
  });

  it('should handle large payloads', () => {
    const payload = new Uint8Array(100000);
    payload.fill(0xff);
    const encoded = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;
    expect(encoded.length).toBe(4 + 100000);
  });
});

describe('decodeFormatPrefix', () => {
  it('should decode a valid format-prefixed payload', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const encoded = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;

    const decoded = decodeFormatPrefix(encoded);
    expect(decoded.format).toBe('devl');
    expect(decoded.payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('should handle legacy non-binary data', () => {
    const legacyData = [1, 'hello', { a: 2 }];
    const decoded = decodeFormatPrefix(legacyData);
    expect(decoded.format).toBe('devl');
    expect(decoded.payload).toEqual(
      new TextEncoder().encode(JSON.stringify(legacyData))
    );
  });

  it('should throw for data too short', () => {
    expect(() => decodeFormatPrefix(new Uint8Array([1, 2, 3]))).toThrow(
      /Data too short to contain format prefix/
    );
    expect(() => decodeFormatPrefix(new Uint8Array([]))).toThrow(
      /Data too short to contain format prefix/
    );
  });

  it('should throw for invalid format prefix bytes', () => {
    // Non-alphanumeric bytes
    const data = new Uint8Array([0, 0, 0, 0, 1, 2, 3]);
    expect(() => decodeFormatPrefix(data)).toThrow(/Invalid format prefix/);
  });

  it('should decode encrypted format prefix', () => {
    const payload = new Uint8Array([10, 20]);
    const encoded = encodeWithFormatPrefix(
      SerializationFormat.ENCRYPTED,
      payload
    ) as Uint8Array;

    const decoded = decodeFormatPrefix(encoded);
    expect(decoded.format).toBe('encr');
    expect(decoded.payload).toEqual(new Uint8Array([10, 20]));
  });
});

describe('peekFormatPrefix', () => {
  it('should return prefix for valid format-prefixed data', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const encoded = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;

    expect(peekFormatPrefix(encoded)).toBe('devl');
  });

  it('should return null for non-binary data', () => {
    expect(peekFormatPrefix('not binary')).toBeNull();
    expect(peekFormatPrefix(42)).toBeNull();
    expect(peekFormatPrefix(null)).toBeNull();
    expect(peekFormatPrefix(undefined)).toBeNull();
  });

  it('should return null for data too short', () => {
    expect(peekFormatPrefix(new Uint8Array([1]))).toBeNull();
    expect(peekFormatPrefix(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('should return null for non-alphanumeric prefix bytes', () => {
    expect(peekFormatPrefix(new Uint8Array([0, 0, 0, 0]))).toBeNull();
    // Uppercase 'D' = 0x44
    expect(
      peekFormatPrefix(new Uint8Array([0x44, 0x45, 0x56, 0x4c]))
    ).toBeNull();
  });

  it('should accept unknown but valid format prefixes', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const encoded = encodeWithFormatPrefix(
      'cbor' as any,
      payload
    ) as Uint8Array;
    expect(peekFormatPrefix(encoded)).toBe('cbor');
  });
});

describe('isEncrypted', () => {
  it('should return true for encrypted data', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const encr = encodeWithFormatPrefix(SerializationFormat.ENCRYPTED, payload);
    expect(isEncrypted(encr)).toBe(true);
  });

  it('should return false for non-encrypted data', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const devl = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    );
    expect(isEncrypted(devl)).toBe(false);
  });

  it('should return false for non-binary data', () => {
    expect(isEncrypted('hello')).toBe(false);
    expect(isEncrypted(42)).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});

// ============================================================================
// encryption.ts — encrypt / decrypt
// ============================================================================

describe('encrypt', () => {
  it('should return data unchanged when no key provided', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const result = await encrypt(data, undefined);
    expect(result).toBe(data);
  });

  it('should return non-Uint8Array data unchanged even with key', async () => {
    const key = await makeKey();
    const data = 'string data';
    const result = await encrypt(data, key);
    expect(result).toBe(data);
  });

  it('should encrypt and add encr prefix when key provided', async () => {
    const key = await makeKey();
    const data = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      new Uint8Array([1, 2, 3])
    ) as Uint8Array;

    const encrypted = await encrypt(data, key);
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(isEncrypted(encrypted)).toBe(true);
  });
});

describe('decrypt', () => {
  it('should return non-binary data unchanged', async () => {
    const data = [1, 2, 3];
    const result = await decrypt(data, undefined);
    expect(result).toBe(data);
  });

  it('should return non-encrypted binary data unchanged', async () => {
    const data = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      new Uint8Array([1, 2, 3])
    ) as Uint8Array;

    const result = await decrypt(data, undefined);
    expect(result).toBe(data);
  });

  it('should throw when encrypted data has no key', async () => {
    const key = await makeKey();
    const data = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      new Uint8Array([1, 2, 3])
    ) as Uint8Array;
    const encrypted = await encrypt(data, key);

    await expect(decrypt(encrypted, undefined)).rejects.toThrow(
      /Encrypted data encountered but no encryption key/
    );
  });

  it('should round-trip encrypt/decrypt', async () => {
    const key = await makeKey();
    const data = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      new Uint8Array([10, 20, 30])
    ) as Uint8Array;

    const encrypted = await encrypt(data, key);
    const decrypted = await decrypt(encrypted, key);
    expect(decrypted).toEqual(data);
  });

  it('attaches the real `encr` envelope prefix to the diagnostic context on auth-tag failure', async () => {
    // The low-level AES layer only sees the stripped payload; this
    // serialization layer is the one that knows the outer envelope marker.
    // Verify it enriches the RuntimeDecryptionError context with the real
    // `encr` prefix (not the first nonce bytes).
    const key = await makeKey();
    const data = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      new Uint8Array([10, 20, 30])
    ) as Uint8Array;
    const encrypted = (await encrypt(data, key)) as Uint8Array;

    // Tamper with the last byte (GCM tag) to force an auth-tag failure.
    const tampered = new Uint8Array(encrypted);
    tampered[tampered.length - 1] ^= 0xff;

    const error = await decrypt(tampered, key).catch((e) => e);
    expect(RuntimeDecryptionError.is(error)).toBe(true);
    expect(error.context).toMatchObject({
      operation: 'decrypt',
      formatPrefix: 'encr',
    });
  });
});

// ============================================================================
// reducers/common.ts — getCommonReducers / getCommonRevivers
// ============================================================================

describe('common reducers', () => {
  const reducers = getCommonReducers();

  it('should reduce ArrayBuffer', () => {
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([1, 2, 3]);
    const result = reducers.ArrayBuffer!(ab);
    expect(typeof result).toBe('string');
    expect(result).not.toBe(false);
  });

  it('should reduce zero-length ArrayBuffer', () => {
    const ab = new ArrayBuffer(0);
    const result = reducers.ArrayBuffer!(ab);
    expect(result).toBe('.');
  });

  it('should return false for non-ArrayBuffer', () => {
    expect(reducers.ArrayBuffer!('not an arraybuffer')).toBe(false);
  });

  it('should reduce BigInt', () => {
    const result = reducers.BigInt!(42n);
    expect(result).toBe('42');
  });

  it('should return false for non-bigint', () => {
    expect(reducers.BigInt!(42)).toBe(false);
  });

  it('should reduce Date', () => {
    const date = new Date('2025-06-15T12:00:00Z');
    const result = reducers.Date!(date);
    expect(result).toBe('2025-06-15T12:00:00.000Z');
  });

  it('should reduce invalid Date to sentinel', () => {
    const result = reducers.Date!(new Date('invalid'));
    expect(result).toBe('.');
  });

  it('should reduce Error', () => {
    const err = new TypeError('test');
    const result = reducers.Error!(err) as Record<string, any>;
    expect(result).not.toBe(false);
    expect(result.name).toBe('TypeError');
    expect(result.message).toBe('test');
    expect(typeof result.stack).toBe('string');
  });

  it('should return false for non-Error objects', () => {
    expect(reducers.Error!({ message: 'fake' })).toBe(false);
    expect(reducers.Error!('not an error')).toBe(false);
  });

  it('should reduce Map', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const result = reducers.Map!(map);
    expect(result).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('should reduce Set', () => {
    const set = new Set([1, 2, 3]);
    const result = reducers.Set!(set);
    expect(result).toEqual([1, 2, 3]);
  });

  it('should reduce URL', () => {
    const url = new URL('https://example.com/path');
    const result = reducers.URL!(url);
    expect(result).toBe('https://example.com/path');
  });

  it('should reduce RegExp', () => {
    const re = /foo/gi;
    const result = reducers.RegExp!(re) as { source: string; flags: string };
    expect(result).toEqual({ source: 'foo', flags: 'gi' });
  });

  it('should reduce Headers', () => {
    const headers = new Headers({ 'Content-Type': 'text/plain' });
    const result = reducers.Headers!(headers) as [string, string][];
    expect(result).toEqual([['content-type', 'text/plain']]);
  });

  it('should reduce URLSearchParams', () => {
    const params = new URLSearchParams('a=1&b=2');
    const result = reducers.URLSearchParams!(params);
    expect(result).toBe('a=1&b=2');
  });

  it('should reduce empty URLSearchParams to sentinel', () => {
    const params = new URLSearchParams();
    const result = reducers.URLSearchParams!(params);
    expect(result).toBe('.');
  });

  it('should reduce Uint8Array', () => {
    const arr = new Uint8Array([1, 2, 3]);
    const result = reducers.Uint8Array!(arr);
    expect(typeof result).toBe('string');
    expect(result).not.toBe(false);
  });

  it('should reduce typed arrays', () => {
    expect(reducers.Int8Array!(new Int8Array([1, 2]))).not.toBe(false);
    expect(reducers.Int16Array!(new Int16Array([1, 2]))).not.toBe(false);
    expect(reducers.Int32Array!(new Int32Array([1, 2]))).not.toBe(false);
    expect(reducers.Float32Array!(new Float32Array([1.0]))).not.toBe(false);
    expect(reducers.Float64Array!(new Float64Array([1.0]))).not.toBe(false);
    expect(reducers.Uint8ClampedArray!(new Uint8ClampedArray([1]))).not.toBe(
      false
    );
    expect(reducers.Uint16Array!(new Uint16Array([1]))).not.toBe(false);
    expect(reducers.Uint32Array!(new Uint32Array([1]))).not.toBe(false);
  });
});

describe('common revivers', () => {
  const revivers = getCommonRevivers();
  const reducers = getCommonReducers();

  it('should round-trip ArrayBuffer', () => {
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([1, 2, 3]);
    const reduced = reducers.ArrayBuffer!(ab) as string;
    const revived = revivers.ArrayBuffer!(reduced) as ArrayBuffer;
    expect(new Uint8Array(revived)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('should round-trip zero-length ArrayBuffer', () => {
    const ab = new ArrayBuffer(0);
    const reduced = reducers.ArrayBuffer!(ab) as string;
    const revived = revivers.ArrayBuffer!(reduced) as ArrayBuffer;
    expect(revived.byteLength).toBe(0);
  });

  it('should round-trip BigInt', () => {
    const reduced = reducers.BigInt!(123456789012345678901234567890n) as string;
    const revived = revivers.BigInt!(reduced);
    expect(revived).toBe(123456789012345678901234567890n);
  });

  it('should round-trip Date', () => {
    const date = new Date('2025-01-15T08:30:00Z');
    const reduced = reducers.Date!(date) as string;
    const revived = revivers.Date!(reduced) as Date;
    expect(revived).toBeInstanceOf(Date);
    expect(revived.toISOString()).toBe('2025-01-15T08:30:00.000Z');
  });

  it('should round-trip Error', () => {
    const err = new RangeError('out of range');
    const reduced = reducers.Error!(err) as Record<string, any>;
    const revived = revivers.Error!(reduced) as Error;
    expect(revived).toBeInstanceOf(Error);
    expect(revived.name).toBe('RangeError');
    expect(revived.message).toBe('out of range');
  });

  it('should round-trip Map', () => {
    const map = new Map<string, number>([
      ['x', 10],
      ['y', 20],
    ]);
    const reduced = reducers.Map!(map) as [string, number][];
    const revived = revivers.Map!(reduced) as Map<string, number>;
    expect(revived).toBeInstanceOf(Map);
    expect(revived.get('x')).toBe(10);
    expect(revived.get('y')).toBe(20);
  });

  it('should round-trip Set', () => {
    const set = new Set([4, 5, 6]);
    const reduced = reducers.Set!(set) as number[];
    const revived = revivers.Set!(reduced) as Set<number>;
    expect(revived).toBeInstanceOf(Set);
    expect(revived.has(4)).toBe(true);
    expect(revived.size).toBe(3);
  });

  it('should round-trip URL', () => {
    const url = new URL('https://test.com/foo?bar=baz');
    const reduced = reducers.URL!(url) as string;
    const revived = revivers.URL!(reduced) as URL;
    expect(revived).toBeInstanceOf(URL);
    expect(revived.href).toBe('https://test.com/foo?bar=baz');
  });

  it('should round-trip RegExp', () => {
    const re = /test\d+/i;
    const reduced = reducers.RegExp!(re) as { source: string; flags: string };
    const revived = revivers.RegExp!(reduced) as RegExp;
    expect(revived).toBeInstanceOf(RegExp);
    expect(revived.source).toBe('test\\d+');
    expect(revived.flags).toBe('i');
  });

  it('should round-trip Headers', () => {
    const headers = new Headers({ Authorization: 'Bearer token' });
    const reduced = reducers.Headers!(headers) as [string, string][];
    const revived = revivers.Headers!(reduced) as Headers;
    expect(revived).toBeInstanceOf(Headers);
    expect(revived.get('authorization')).toBe('Bearer token');
  });

  it('should round-trip URLSearchParams', () => {
    const params = new URLSearchParams('foo=1&bar=2');
    const reduced = reducers.URLSearchParams!(params) as string;
    const revived = revivers.URLSearchParams!(reduced) as URLSearchParams;
    expect(revived).toBeInstanceOf(URLSearchParams);
    expect(revived.get('foo')).toBe('1');
    expect(revived.get('bar')).toBe('2');
  });

  it('should round-trip empty URLSearchParams', () => {
    const params = new URLSearchParams();
    const reduced = reducers.URLSearchParams!(params) as string;
    const revived = revivers.URLSearchParams!(reduced) as URLSearchParams;
    expect(revived).toBeInstanceOf(URLSearchParams);
    expect(revived.size).toBe(0);
  });

  it('should round-trip typed arrays', () => {
    const cases: [string, ArrayBufferView][] = [
      ['Int8Array', new Int8Array([1, -2])],
      ['Int16Array', new Int16Array([1000, -2000])],
      ['Int32Array', new Int32Array([100000, -200000])],
      ['Float32Array', new Float32Array([1.5])],
      ['Float64Array', new Float64Array([1.123456789])],
      ['Uint8ClampedArray', new Uint8ClampedArray([255, 0])],
      ['Uint16Array', new Uint16Array([65535])],
      ['Uint32Array', new Uint32Array([4294967295])],
    ];

    for (const [name, arr] of cases) {
      const reduced = (reducers as any)[name]!(arr) as string;
      const revived = (revivers as any)[name]!(reduced) as ArrayBufferView;
      expect(revived.constructor.name).toBe(name);
      expect(Array.from(new Uint8Array(revived.buffer))).toEqual(
        Array.from(new Uint8Array(arr.buffer))
      );
    }
  });
});

// ============================================================================
// reducers/class.ts — getClassReducers / getClassRevivers
// ============================================================================

describe('class reducers', () => {
  const reducers = getClassReducers();

  it('should reduce class constructors with classId', () => {
    const MyClass = class MyClass {} as any;
    MyClass.classId = 'test-class-id';

    const result = reducers.Class!(MyClass);
    expect(result).toEqual({ classId: 'test-class-id' });
  });

  it('should return false for non-functions', () => {
    expect(reducers.Class!('not a function')).toBe(false);
    expect(reducers.Class!(42)).toBe(false);
    expect(reducers.Class!({})).toBe(false);
  });

  it('should return false for functions without classId', () => {
    expect(reducers.Class!(() => {})).toBe(false);
  });

  it('should reduce instances with WORKFLOW_SERIALIZE', () => {
    class SerializableClass {
      value: number;
      constructor(value: number) {
        this.value = value;
      }
      static classId = 'serializable-test';
      static [WORKFLOW_SERIALIZE](instance: SerializableClass) {
        return { v: instance.value };
      }
    }

    const instance = new SerializableClass(42);
    const result = reducers.Instance!(instance) as {
      classId: string;
      data: any;
    };
    expect(result).toEqual({ classId: 'serializable-test', data: { v: 42 } });
  });

  it('should return false for instances without WORKFLOW_SERIALIZE', () => {
    const instance = { hello: 'world' };
    expect(reducers.Instance!(instance)).toBe(false);
  });

  it('should throw for instances with WORKFLOW_SERIALIZE but no classId', () => {
    class NoClassId {
      static [WORKFLOW_SERIALIZE]() {
        return {};
      }
    }
    expect(() => reducers.Instance!(new NoClassId())).toThrow(/classId/);
  });

  it('should return false for null/primitive values in Instance', () => {
    expect(reducers.Instance!(null)).toBe(false);
    expect(reducers.Instance!(42)).toBe(false);
    expect(reducers.Instance!('string')).toBe(false);
  });
});

describe('class revivers', () => {
  it('should revive Class by looking up from registry', () => {
    class RevivableClass {
      static classId = 'revivable-test';
    }
    registerSerializationClass('revivable-test', RevivableClass);

    const revivers = getClassRevivers();
    const result = revivers.Class!({ classId: 'revivable-test' });
    expect(result).toBe(RevivableClass);
  });

  it('should throw for unknown classId', () => {
    const revivers = getClassRevivers();
    expect(() => revivers.Class!({ classId: 'non-existent-class' })).toThrow(
      /not found/
    );
  });

  it('should revive Instance with WORKFLOW_DESERIALIZE', () => {
    class DeserializableClass {
      value: number;
      constructor(value: number) {
        this.value = value;
      }
      static classId = 'deserializable-test';
      static [WORKFLOW_DESERIALIZE](data: { v: number }) {
        return new DeserializableClass(data.v);
      }
    }
    registerSerializationClass('deserializable-test', DeserializableClass);

    const revivers = getClassRevivers();
    const result = revivers.Instance!({
      classId: 'deserializable-test',
      data: { v: 99 },
    }) as any;
    expect(result).toBeInstanceOf(DeserializableClass);
    expect(result.value).toBe(99);
  });

  it('should throw when Instance class has no WORKFLOW_DESERIALIZE', () => {
    class NoDeserialize {
      static classId = 'no-deserialize-test';
    }
    registerSerializationClass('no-deserialize-test', NoDeserialize);

    const revivers = getClassRevivers();
    expect(() =>
      revivers.Instance!({
        classId: 'no-deserialize-test',
        data: {},
      })
    ).toThrow(/does not have a static/);
  });
});

// ============================================================================
// reducers/step-function.ts — getStepFunctionReducer / getStepFunctionReviver
// ============================================================================

describe('step function reducer', () => {
  const reducers = getStepFunctionReducer();

  it('should reduce function with stepId', () => {
    const fn = Object.assign(() => {}, { stepId: 'step//test//myStep' });
    const result = reducers.StepFunction!(fn);
    expect(result).toEqual({ stepId: 'step//test//myStep' });
  });

  it('should include closure variables if __closureVarsFn exists', () => {
    const fn = Object.assign(() => {}, {
      stepId: 'step//test//withClosure',
      __closureVarsFn: () => ({ x: 1, y: 'hello' }),
    });
    const result = reducers.StepFunction!(fn) as {
      stepId: string;
      closureVars: Record<string, unknown>;
    };
    expect(result).toEqual({
      stepId: 'step//test//withClosure',
      closureVars: { x: 1, y: 'hello' },
    });
  });

  it('should return false for non-functions', () => {
    expect(reducers.StepFunction!(42)).toBe(false);
    expect(reducers.StepFunction!('hello')).toBe(false);
    expect(reducers.StepFunction!({})).toBe(false);
  });

  it('should return false for functions without stepId', () => {
    expect(reducers.StepFunction!(() => {})).toBe(false);
  });

  it('should include `boundThis` when the proxy has the marker property', () => {
    // Simulates a step proxy that was created via `useStep(...).bind(thisArg)`.
    // The actual `.bind` override on real proxies (in step.ts) attaches
    // `__boundThis` so the reducer can serialize the captured `this`.
    const instance = { kind: 'workflow-side' };
    const fn = Object.defineProperties(() => {}, {
      stepId: { value: 'step//test//withBoundThis' },
      __boundThis: { value: instance },
    });
    const result = reducers.StepFunction!(fn);
    expect(result).toEqual({
      stepId: 'step//test//withBoundThis',
      boundThis: instance,
    });
  });

  it('should round-trip a `null`/`undefined` bound `this`', () => {
    // `Function.prototype.bind(null)` and `bind(undefined)` are valid; the
    // reducer must use property presence rather than truthiness so the
    // distinction round-trips faithfully.
    const fnNull = Object.defineProperties(() => {}, {
      stepId: { value: 'step//test//boundNull' },
      __boundThis: { value: null },
    });
    expect(reducers.StepFunction!(fnNull)).toEqual({
      stepId: 'step//test//boundNull',
      boundThis: null,
    });

    const fnUndef = Object.defineProperties(() => {}, {
      stepId: { value: 'step//test//boundUndef' },
      __boundThis: { value: undefined },
    });
    expect(reducers.StepFunction!(fnUndef)).toEqual({
      stepId: 'step//test//boundUndef',
      boundThis: undefined,
    });
  });
});

describe('step function reviver', () => {
  it('should call WORKFLOW_USE_STEP when available', () => {
    const mockProxy = () => {};
    const mockUseStep = vi.fn().mockReturnValue(mockProxy);
    const global = {
      [Symbol.for('WORKFLOW_USE_STEP')]: mockUseStep,
    };

    const revivers = getStepFunctionReviver(global);
    const result = revivers.StepFunction!({ stepId: 'step//test//myStep' });
    expect(result).toBe(mockProxy);
    expect(mockUseStep).toHaveBeenCalledWith('step//test//myStep');
  });

  it('should pass closure vars function when present', () => {
    const mockProxy = () => {};
    const mockUseStep = vi.fn().mockReturnValue(mockProxy);
    const global = {
      [Symbol.for('WORKFLOW_USE_STEP')]: mockUseStep,
    };

    const revivers = getStepFunctionReviver(global);
    revivers.StepFunction!({
      stepId: 'step//test//withClosure',
      closureVars: { x: 42 },
    });
    expect(mockUseStep).toHaveBeenCalledWith(
      'step//test//withClosure',
      expect.any(Function)
    );
    // Verify the closure vars function returns the correct values
    const closureVarsFn = mockUseStep.mock.calls[0][1];
    expect(closureVarsFn()).toEqual({ x: 42 });
  });

  it('should throw when WORKFLOW_USE_STEP is not available', () => {
    const revivers = getStepFunctionReviver({});
    expect(() =>
      revivers.StepFunction!({ stepId: 'step//test//myStep' })
    ).toThrow(/WORKFLOW_USE_STEP not found/);
  });

  it('should re-bind the proxy when `boundThis` is present in the payload', () => {
    // Simulates the round trip for a step proxy that was created via
    // `useStep(...).bind(thisArg)` in the workflow bundle and then passed
    // as a step argument: the reducer captures `boundThis`, and the
    // reviver in the step bundle must re-bind the freshly created proxy
    // so the original `this` survives the serialization round trip.
    const recordedThisVals: unknown[] = [];
    const proxy = function (this: unknown) {
      recordedThisVals.push(this);
      return 'result';
    };
    const mockUseStep = vi.fn().mockReturnValue(proxy);
    const global = {
      [Symbol.for('WORKFLOW_USE_STEP')]: mockUseStep,
    };

    const instance = { restored: true };
    const revivers = getStepFunctionReviver(global);
    const result = revivers.StepFunction!({
      stepId: 'step//test//withBoundThis',
      boundThis: instance,
    }) as () => unknown;

    expect(typeof result).toBe('function');
    expect(mockUseStep).toHaveBeenCalledWith('step//test//withBoundThis');

    // Invoking the revived proxy without an explicit receiver should
    // observe the bound `this`, not `undefined`.
    result();
    expect(recordedThisVals).toEqual([instance]);
  });
});

// ============================================================================
// codec-devalue.ts — devalueCodec
// ============================================================================

describe('devalue codec', () => {
  it('should have the correct format prefix', () => {
    expect(devalueCodec.formatPrefix).toBe('devl');
  });

  it('should round-trip primitives in all modes', () => {
    const modes: ('workflow' | 'step' | 'client')[] = [
      'workflow',
      'step',
      'client',
    ];
    for (const mode of modes) {
      for (const value of [42, 'hello', true, null, 0, -1, '', false]) {
        const serialized = devalueCodec.serialize(value, mode);
        const deserialized = devalueCodec.deserialize(serialized, mode);
        expect(deserialized).toEqual(value);
      }
    }
  });

  it('should round-trip Date via all modes', () => {
    const date = new Date('2025-01-01T00:00:00Z');
    for (const mode of ['workflow', 'step', 'client'] as const) {
      const serialized = devalueCodec.serialize(date, mode);
      const deserialized = devalueCodec.deserialize(serialized, mode) as Date;
      expect(deserialized).toBeInstanceOf(Date);
      expect(deserialized.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    }
  });

  it('should round-trip nested objects', () => {
    const value = { a: { b: { c: [1, 2, { d: 'deep' }] } } };
    const serialized = devalueCodec.serialize(value, 'workflow');
    const deserialized = devalueCodec.deserialize(serialized, 'workflow');
    expect(deserialized).toEqual(value);
  });

  it('should round-trip Map in all modes', () => {
    const map = new Map([
      ['key1', 'val1'],
      ['key2', 'val2'],
    ]);
    for (const mode of ['workflow', 'step', 'client'] as const) {
      const serialized = devalueCodec.serialize(map, mode);
      const deserialized = devalueCodec.deserialize(serialized, mode) as Map<
        string,
        string
      >;
      expect(deserialized).toBeInstanceOf(Map);
      expect(deserialized.get('key1')).toBe('val1');
    }
  });

  it('should round-trip Set in all modes', () => {
    const set = new Set(['a', 'b', 'c']);
    for (const mode of ['workflow', 'step', 'client'] as const) {
      const serialized = devalueCodec.serialize(set, mode);
      const deserialized = devalueCodec.deserialize(
        serialized,
        mode
      ) as Set<string>;
      expect(deserialized).toBeInstanceOf(Set);
      expect(deserialized.has('a')).toBe(true);
    }
  });

  it('should support deserializeLegacy', () => {
    // Simulate legacy data (devalue unflatten format)
    const { stringify } = require('devalue');
    const value = { test: 'legacy' };
    const str = stringify(value);
    // biome-ignore lint/security/noGlobalEval: test
    const legacyArray = (0, eval)(`(${str})`);

    const result = devalueCodec.deserializeLegacy!(legacyArray, 'workflow');
    expect(result).toEqual(value);
  });

  it('should produce Uint8Array output from serialize', () => {
    const serialized = devalueCodec.serialize(42, 'workflow');
    expect(serialized).toBeInstanceOf(Uint8Array);
  });

  it('should include StepFunction in workflow mode reducers', () => {
    const fn = Object.assign(() => {}, { stepId: 'test-step' });
    // This should not throw in workflow mode (StepFunction reducer is included)
    const serialized = devalueCodec.serialize(fn, 'workflow');
    expect(serialized).toBeInstanceOf(Uint8Array);
  });

  it('should throw for StepFunction deserialization in client mode', () => {
    // Serialize a step function in workflow mode, then try to deserialize in client mode
    const fn = Object.assign(() => {}, { stepId: 'test-step' });
    const serialized = devalueCodec.serialize(fn, 'workflow');
    expect(() => devalueCodec.deserialize(serialized, 'client')).toThrow(
      /Step functions cannot be deserialized in client context/
    );
  });
});

// ============================================================================
// workflow.ts — workflow mode serialize / deserialize
// ============================================================================

describe('workflow.serialize / workflow.deserialize', () => {
  it('should round-trip primitives', () => {
    expect(workflow.deserialize(workflow.serialize(42))).toBe(42);
    expect(workflow.deserialize(workflow.serialize('hello'))).toBe('hello');
    expect(workflow.deserialize(workflow.serialize(true))).toBe(true);
    expect(workflow.deserialize(workflow.serialize(null))).toBe(null);
    expect(workflow.deserialize(workflow.serialize(0))).toBe(0);
    expect(workflow.deserialize(workflow.serialize(''))).toBe('');
    expect(workflow.deserialize(workflow.serialize(false))).toBe(false);
  });

  it('should round-trip arrays and objects', () => {
    const value = { a: 1, b: [2, 3], c: { d: 'e' } };
    expect(workflow.deserialize(workflow.serialize(value))).toEqual(value);
  });

  it('should round-trip empty objects and arrays', () => {
    expect(workflow.deserialize(workflow.serialize({}))).toEqual({});
    expect(workflow.deserialize(workflow.serialize([]))).toEqual([]);
  });

  it('should round-trip Date', () => {
    const date = new Date('2025-06-15T12:00:00Z');
    const result = workflow.deserialize(workflow.serialize(date)) as Date;
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe('2025-06-15T12:00:00.000Z');
  });

  it('should round-trip Error', () => {
    const err = new TypeError('test error');
    const result = workflow.deserialize(workflow.serialize(err)) as Error;
    expect(result).toBeInstanceOf(Error);
    expect(result.name).toBe('TypeError');
    expect(result.message).toBe('test error');
  });

  it('should round-trip Map', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const result = workflow.deserialize(workflow.serialize(map)) as Map<
      string,
      number
    >;
    expect(result).toBeInstanceOf(Map);
    expect(result.get('a')).toBe(1);
    expect(result.get('b')).toBe(2);
  });

  it('should round-trip Set', () => {
    const set = new Set([1, 2, 3]);
    const result = workflow.deserialize(workflow.serialize(set)) as Set<number>;
    expect(result).toBeInstanceOf(Set);
    expect(result.has(1)).toBe(true);
    expect(result.has(3)).toBe(true);
    expect(result.size).toBe(3);
  });

  it('should round-trip BigInt', () => {
    const value = 9007199254740993n;
    const result = workflow.deserialize(workflow.serialize(value));
    expect(result).toBe(value);
  });

  it('should round-trip Uint8Array', () => {
    const value = new Uint8Array([1, 2, 3, 4, 5]);
    const result = workflow.deserialize(
      workflow.serialize(value)
    ) as Uint8Array;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should round-trip URL', () => {
    const url = new URL('https://example.com/path?q=1');
    const result = workflow.deserialize(workflow.serialize(url)) as URL;
    expect(result).toBeInstanceOf(URL);
    expect(result.href).toBe('https://example.com/path?q=1');
  });

  it('should round-trip RegExp', () => {
    const re = /foo.*bar/gi;
    const result = workflow.deserialize(workflow.serialize(re)) as RegExp;
    expect(result).toBeInstanceOf(RegExp);
    expect(result.source).toBe('foo.*bar');
    expect(result.flags).toBe('gi');
  });

  it('should round-trip Headers', () => {
    const headers = new Headers({ 'X-Custom': 'value' });
    const result = workflow.deserialize(workflow.serialize(headers)) as Headers;
    expect(result).toBeInstanceOf(Headers);
    expect(result.get('x-custom')).toBe('value');
  });

  it('should round-trip nested complex types', () => {
    const value = {
      date: new Date('2025-01-01'),
      map: new Map([['k', 42]]),
      set: new Set([1, 2]),
      nested: {
        url: new URL('https://example.com'),
        re: /test/i,
      },
    };
    const result = workflow.deserialize(workflow.serialize(value)) as any;
    expect(result.date).toBeInstanceOf(Date);
    expect(result.map).toBeInstanceOf(Map);
    expect(result.map.get('k')).toBe(42);
    expect(result.set).toBeInstanceOf(Set);
    expect(result.nested.url).toBeInstanceOf(URL);
    expect(result.nested.re).toBeInstanceOf(RegExp);
  });

  it('should produce format-prefixed output', () => {
    const serialized = workflow.serialize(42);
    expect(serialized).toBeInstanceOf(Uint8Array);
    expect(peekFormatPrefix(serialized)).toBe('devl');
  });

  it('should throw WorkflowRuntimeError for non-serializable values', () => {
    // Functions without stepId cannot be serialized
    const fn = function notSerializable() {};
    expect(() => workflow.serialize(fn)).toThrow(/Failed to serialize/);
  });

  it('should deserialize legacy non-binary data', () => {
    // Simulate legacy format (devalue unflatten array)
    const { stringify } = require('devalue');
    const value = { hello: 'world' };
    const str = stringify(value);
    // biome-ignore lint/security/noGlobalEval: test
    const legacyArray = (0, eval)(`(${str})`);

    const result = workflow.deserialize(legacyArray) as any;
    expect(result).toEqual(value);
  });

  it('should throw for unsupported format prefix', () => {
    const data = new TextEncoder().encode('cbor{"test":true}');
    expect(() => workflow.deserialize(data)).toThrow(
      /Unsupported serialization format/
    );
  });
});

// ============================================================================
// step.ts — step mode serialize / deserialize
// ============================================================================

describe('step.serialize / step.deserialize', () => {
  it('should round-trip primitives', async () => {
    const serialized = await step.serialize(42);
    const result = await step.deserialize(serialized);
    expect(result).toBe(42);
  });

  it('should round-trip strings', async () => {
    const serialized = await step.serialize('hello world');
    const result = await step.deserialize(serialized);
    expect(result).toBe('hello world');
  });

  it('should round-trip Date', async () => {
    const date = new Date('2025-01-01');
    const serialized = await step.serialize(date);
    const result = (await step.deserialize(serialized)) as Date;
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toContain('2025-01-01');
  });

  it('should round-trip complex objects', async () => {
    const value = {
      items: [1, 'two'],
      map: new Map([['a', 1]]),
      set: new Set([1, 2]),
      date: new Date('2025-06-15'),
    };
    const serialized = await step.serialize(value);
    const result = (await step.deserialize(serialized)) as any;
    expect(result.items).toEqual([1, 'two']);
    expect(result.map).toBeInstanceOf(Map);
    expect(result.set).toBeInstanceOf(Set);
    expect(result.date).toBeInstanceOf(Date);
  });

  it('should support encryption round-trip', async () => {
    const key = await makeKey();
    const value = { secret: 'data', count: 42 };
    const encrypted = await step.serialize(value, key);

    expect(isEncrypted(encrypted)).toBe(true);

    const result = await step.deserialize(encrypted, key);
    expect(result).toEqual(value);
  });

  it('should produce format-prefixed output without encryption', async () => {
    const serialized = (await step.serialize(42)) as Uint8Array;
    expect(peekFormatPrefix(serialized)).toBe('devl');
  });

  it('should produce encr-prefixed output with encryption', async () => {
    const key = await makeKey();
    const serialized = (await step.serialize(42, key)) as Uint8Array;
    expect(peekFormatPrefix(serialized)).toBe('encr');
  });

  it('should throw for encrypted data without key', async () => {
    const key = await makeKey();
    const encrypted = await step.serialize({ test: true }, key);
    await expect(step.deserialize(encrypted)).rejects.toThrow(
      /Encrypted data encountered but no encryption key/
    );
  });

  it('should deserialize legacy non-binary data', async () => {
    const { stringify } = require('devalue');
    const value = { hello: 'step' };
    const str = stringify(value);
    // biome-ignore lint/security/noGlobalEval: test
    const legacyArray = (0, eval)(`(${str})`);

    const result = await step.deserialize(legacyArray);
    expect(result).toEqual(value);
  });
});

// ============================================================================
// client.ts — client mode serialize / deserialize
// ============================================================================

describe('client.serialize / client.deserialize', () => {
  it('should round-trip primitives', async () => {
    const serialized = await client.serialize(42);
    const result = await client.deserialize(serialized);
    expect(result).toBe(42);
  });

  it('should round-trip complex values', async () => {
    const value = { items: [1, 'two', new Date('2025-01-01')] };
    const serialized = await client.serialize(value);
    const result = (await client.deserialize(serialized)) as any;
    expect(result.items[0]).toBe(1);
    expect(result.items[1]).toBe('two');
    expect(result.items[2]).toBeInstanceOf(Date);
  });

  it('should support encryption round-trip', async () => {
    const key = await makeKey();
    const value = { secret: 'client-data' };
    const encrypted = await client.serialize(value, key);

    expect(isEncrypted(encrypted)).toBe(true);

    const result = await client.deserialize(encrypted, key);
    expect(result).toEqual(value);
  });

  it('should round-trip Map and Set', async () => {
    const value = {
      map: new Map([['x', 1]]),
      set: new Set(['a', 'b']),
    };
    const serialized = await client.serialize(value);
    const result = (await client.deserialize(serialized)) as any;
    expect(result.map).toBeInstanceOf(Map);
    expect(result.map.get('x')).toBe(1);
    expect(result.set).toBeInstanceOf(Set);
    expect(result.set.has('a')).toBe(true);
  });

  it('should throw for encrypted data without key', async () => {
    const key = await makeKey();
    const encrypted = await client.serialize({ test: true }, key);
    await expect(client.deserialize(encrypted)).rejects.toThrow(
      /Encrypted data encountered but no encryption key/
    );
  });
});

// ============================================================================
// Cross-mode compatibility
// ============================================================================

describe('cross-mode serialization', () => {
  it('workflow serialize → step deserialize', async () => {
    const value = { x: 42, date: new Date('2025-01-01') };
    const serialized = workflow.serialize(value);
    const result = (await step.deserialize(serialized)) as any;
    expect(result.x).toBe(42);
    expect(result.date).toBeInstanceOf(Date);
  });

  it('step serialize → workflow deserialize', async () => {
    const value = { y: 'hello', set: new Set([1, 2]) };
    const serialized = await step.serialize(value);
    const result = workflow.deserialize(serialized) as any;
    expect(result.y).toBe('hello');
    expect(result.set).toBeInstanceOf(Set);
  });

  it('client serialize → workflow deserialize', async () => {
    const value = [1, 'two', true];
    const serialized = await client.serialize(value);
    const result = workflow.deserialize(serialized);
    expect(result).toEqual(value);
  });

  it('workflow serialize → client deserialize', async () => {
    const value = { map: new Map([['a', 1]]) };
    const serialized = workflow.serialize(value);
    const result = (await client.deserialize(serialized)) as any;
    expect(result.map).toBeInstanceOf(Map);
    expect(result.map.get('a')).toBe(1);
  });

  it('client serialize → step deserialize', async () => {
    const value = { bigint: 42n, url: new URL('https://test.com') };
    const serialized = await client.serialize(value);
    const result = (await step.deserialize(serialized)) as any;
    expect(result.bigint).toBe(42n);
    expect(result.url).toBeInstanceOf(URL);
  });

  it('step serialize → client deserialize', async () => {
    const value = { headers: new Headers({ 'X-Test': 'value' }) };
    const serialized = await step.serialize(value);
    const result = (await client.deserialize(serialized)) as any;
    expect(result.headers).toBeInstanceOf(Headers);
    expect(result.headers.get('x-test')).toBe('value');
  });

  it('cross-mode with encryption: step(encrypted) → client(decrypt)', async () => {
    const key = await makeKey();
    const value = { secret: 'cross-mode' };
    const encrypted = await step.serialize(value, key);
    const result = await client.deserialize(encrypted, key);
    expect(result).toEqual(value);
  });

  it('cross-mode with encryption: client(encrypted) → step(decrypt)', async () => {
    const key = await makeKey();
    const value = { data: [1, 2, 3] };
    const encrypted = await client.serialize(value, key);
    const result = await step.deserialize(encrypted, key);
    expect(result).toEqual(value);
  });
});

// ============================================================================
// Edge cases & error handling
// ============================================================================

describe('edge cases', () => {
  it('should handle undefined values in objects', () => {
    // devalue handles undefined differently than JSON
    const value = { a: 1, b: undefined };
    const result = workflow.deserialize(workflow.serialize(value)) as any;
    expect(result.a).toBe(1);
    expect('b' in result).toBe(true);
    expect(result.b).toBeUndefined();
  });

  it('should handle circular references', () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    // devalue supports circular references
    const result = workflow.deserialize(workflow.serialize(obj)) as any;
    expect(result.a).toBe(1);
    expect(result.self).toBe(result);
  });

  it('should handle deeply nested structures', () => {
    let value: any = { depth: 0 };
    for (let i = 1; i <= 50; i++) {
      value = { depth: i, child: value };
    }
    const result = workflow.deserialize(workflow.serialize(value)) as any;
    expect(result.depth).toBe(50);
    let current = result;
    for (let i = 50; i >= 0; i--) {
      expect(current.depth).toBe(i);
      current = current.child;
    }
  });

  it('should handle arrays with mixed types', () => {
    const value = [
      42,
      'string',
      true,
      null,
      new Date('2025-01-01'),
      new Map([['k', 'v']]),
      new Set([1]),
      /test/g,
      new URL('https://example.com'),
    ];
    const result = workflow.deserialize(workflow.serialize(value)) as any[];
    expect(result[0]).toBe(42);
    expect(result[1]).toBe('string');
    expect(result[2]).toBe(true);
    expect(result[3]).toBeNull();
    expect(result[4]).toBeInstanceOf(Date);
    expect(result[5]).toBeInstanceOf(Map);
    expect(result[6]).toBeInstanceOf(Set);
    expect(result[7]).toBeInstanceOf(RegExp);
    expect(result[8]).toBeInstanceOf(URL);
  });

  it('should handle empty Map and Set', () => {
    const value = { map: new Map(), set: new Set() };
    const result = workflow.deserialize(workflow.serialize(value)) as any;
    expect(result.map).toBeInstanceOf(Map);
    expect(result.map.size).toBe(0);
    expect(result.set).toBeInstanceOf(Set);
    expect(result.set.size).toBe(0);
  });

  it('should handle BigInt edge values', () => {
    const values = [0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n];
    for (const v of values) {
      const result = workflow.deserialize(workflow.serialize(v));
      expect(result).toBe(v);
    }
  });

  it('should handle empty Uint8Array', () => {
    const arr = new Uint8Array(0);
    const result = workflow.deserialize(workflow.serialize(arr)) as Uint8Array;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });
});
