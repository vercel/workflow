import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hydrateData } from '@workflow/core/serialization-format';
import { getCLIRevivers } from '../../cli/src/lib/inspect/hydration.js';
import { getWebRevivers } from '../src/lib/hydration.js';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERIALIZABLE_TYPES_PATH = fileURLToPath(
  new URL('../../core/src/serialization/types.ts', import.meta.url)
);

function propertyNameToString(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
}

function readSerializableSpecialKeys(): string[] {
  const source = ts.createSourceFile(
    SERIALIZABLE_TYPES_PATH,
    readFileSync(SERIALIZABLE_TYPES_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let keys: string[] | undefined;
  source.forEachChild((node) => {
    if (
      ts.isInterfaceDeclaration(node) &&
      node.name.text === 'SerializableSpecial'
    ) {
      keys = node.members.flatMap((member) => {
        if (!ts.isPropertySignature(member)) return [];
        const key = propertyNameToString(member.name);
        return key ? [key] : [];
      });
    }
  });

  if (!keys) {
    throw new Error(
      `Could not find SerializableSpecial in ${SERIALIZABLE_TYPES_PATH}`
    );
  }
  return keys.sort();
}

const SERIALIZABLE_SPECIAL_KEYS = readSerializableSpecialKeys();

const SERIALIZABLE_PAYLOADS: Record<string, unknown[]> = {
  AbortController: [
    ['AbortController', 1],
    { streamName: 2, hookToken: 3, aborted: 4 },
    'abort-stream',
    'hook-token',
    false,
  ],
  AbortSignal: [
    ['AbortSignal', 1],
    { streamName: 2, hookToken: 3, aborted: 4 },
    'abort-stream',
    'hook-token',
    false,
  ],
  AggregateError: [
    ['AggregateError', 1],
    { message: 2, errors: 3 },
    'all failed',
    [4],
    'inner',
  ],
  ArrayBuffer: [['ArrayBuffer', 1], '.'],
  BigInt: [['BigInt', 1], '1'],
  BigInt64Array: [['BigInt64Array', 1], '.'],
  BigUint64Array: [['BigUint64Array', 1], '.'],
  Class: [['Class', 1], { classId: 2 }, 'class//Example'],
  Date: [['Date', 1], '2025-01-01T00:00:00.000Z'],
  DOMException: [
    ['DOMException', 1],
    { message: 2, name: 3 },
    'aborted',
    'AbortError',
  ],
  Error: [['Error', 1], { name: 2, message: 3 }, 'Error', 'boom'],
  EvalError: [['EvalError', 1], { message: 2 }, 'boom'],
  FatalError: [['FatalError', 1], { message: 2 }, 'cannot retry'],
  Float32Array: [['Float32Array', 1], '.'],
  Float64Array: [['Float64Array', 1], '.'],
  Headers: [['Headers', 1], [2], [3, 4], 'x-test', 'value'],
  HookConflictError: [
    ['HookConflictError', 1],
    { message: 2, token: 3, conflictingRunId: 4 },
    'Hook token "approval-token" is already in use by another workflow (run "wrun_conflicting")',
    'approval-token',
    'wrun_conflicting',
  ],
  Instance: [
    ['Instance', 1],
    { classId: 2, data: 3 },
    'class//Example',
    'data',
  ],
  Int8Array: [['Int8Array', 1], '.'],
  Int16Array: [['Int16Array', 1], '.'],
  Int32Array: [['Int32Array', 1], '.'],
  Map: [['Map', 1], [2], [3, 4], 'key', 'value'],
  RangeError: [['RangeError', 1], { message: 2 }, 'boom'],
  ReadableStream: [['ReadableStream', 1], { name: 2 }, 'stream-a'],
  ReferenceError: [['ReferenceError', 1], { message: 2 }, 'boom'],
  RegExp: [['RegExp', 1], { source: 2, flags: 3 }, 'abc', 'i'],
  Request: [
    ['Request', 1],
    { method: 2, url: 3, headers: 4, body: 5, duplex: 6 },
    'POST',
    'https://example.com/request',
    [7],
    null,
    'half',
    [8, 9],
    'x-test',
    'value',
  ],
  Response: [
    ['Response', 1],
    {
      type: 2,
      url: 3,
      status: 4,
      statusText: 5,
      headers: 6,
      body: 7,
      redirected: 8,
    },
    'basic',
    'https://example.com/response',
    200,
    'OK',
    [9],
    null,
    false,
    [10, 11],
    'x-test',
    'value',
  ],
  RetryableError: [
    ['RetryableError', 1],
    { message: 2, retryAfter: 3 },
    'try again',
    Date.UTC(2025, 0, 1),
  ],
  RuntimeDecryptionError: [
    ['RuntimeDecryptionError', 1],
    { message: 2, context: 3 },
    'decrypt failed',
    { operation: 4 },
    'hydrate',
  ],
  Set: [['Set', 1], [2], 'value'],
  StepFunction: [['StepFunction', 1], { stepId: 2 }, 'step//example'],
  SyntaxError: [['SyntaxError', 1], { message: 2 }, 'boom'],
  TypeError: [['TypeError', 1], { message: 2 }, 'boom'],
  URIError: [['URIError', 1], { message: 2 }, 'boom'],
  URL: [['URL', 1], 'https://example.com/path'],
  URLSearchParams: [['URLSearchParams', 1], 'a=1'],
  Uint8Array: [['Uint8Array', 1], '.'],
  Uint8ClampedArray: [['Uint8ClampedArray', 1], '.'],
  Uint16Array: [['Uint16Array', 1], '.'],
  Uint32Array: [['Uint32Array', 1], '.'],
  WorkflowFunction: [
    ['WorkflowFunction', 1],
    { workflowId: 2 },
    'workflow//example',
  ],
  WritableStream: [['WritableStream', 1], { name: 2 }, 'stream-a'],
};

describe('serializable type reviver surfaces', () => {
  it('has a fixture for every SerializableSpecial key', () => {
    expect(Object.keys(SERIALIZABLE_PAYLOADS).sort()).toEqual(
      SERIALIZABLE_SPECIAL_KEYS
    );
  });

  it.each([
    ['web-shared', getWebRevivers()],
    ['CLI', getCLIRevivers()],
  ])('%s can deserialize every SerializableSpecial key', (_name, revivers) => {
    const missing = SERIALIZABLE_SPECIAL_KEYS.filter(
      (key) => typeof (revivers as Record<string, unknown>)[key] !== 'function'
    );
    expect(missing).toEqual([]);

    for (const key of SERIALIZABLE_SPECIAL_KEYS) {
      expect(() => {
        hydrateData(SERIALIZABLE_PAYLOADS[key], revivers);
      }, key).not.toThrow();
    }
  });
});
