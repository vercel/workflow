/**
 * Compatibility tests: verify that data serialized by the new modules
 * can be deserialized by the old serialization.ts functions, and vice versa.
 *
 * This ensures the new modules are safe to use alongside the old code
 * during the migration period.
 */

import { describe, it, expect } from 'vitest';
import * as workflow from './workflow.js';
import * as step from './step.js';
import * as client from './client.js';
import {
  dehydrateWorkflowArguments,
  hydrateWorkflowArguments,
  dehydrateWorkflowReturnValue,
  hydrateWorkflowReturnValue,
  dehydrateStepArguments,
  hydrateStepArguments,
  dehydrateStepReturnValue,
  hydrateStepReturnValue,
} from '../serialization.js';
import { importKey } from '../encryption.js';

const testData = {
  primitives: [42, 'hello', true, null],
  date: new Date('2025-06-15T12:00:00Z'),
  error: Object.assign(new Error('test'), { name: 'TypeError' }),
  map: new Map([
    ['a', 1],
    ['b', 2],
  ]),
  set: new Set([1, 2, 3]),
  bigint: 9007199254740993n,
  uint8: new Uint8Array([1, 2, 3]),
  url: new URL('https://example.com'),
  regexp: /foo.*bar/gi,
  nested: {
    items: [1, 'two', new Date('2025-01-01')],
    inner: { x: 42 },
  },
};

describe('new workflow.serialize → old hydrateStepReturnValue', () => {
  it('should round-trip primitives', async () => {
    for (const val of testData.primitives) {
      const serialized = workflow.serialize(val);
      const hydrated = await hydrateStepReturnValue(
        serialized,
        'run-123',
        undefined
      );
      expect(hydrated).toEqual(val);
    }
  });

  it('should round-trip Date', async () => {
    const serialized = workflow.serialize(testData.date);
    const hydrated = (await hydrateStepReturnValue(
      serialized,
      'run-123',
      undefined
    )) as Date;
    expect(hydrated).toBeInstanceOf(Date);
    expect(hydrated.toISOString()).toBe('2025-06-15T12:00:00.000Z');
  });

  it('should round-trip Map', async () => {
    const serialized = workflow.serialize(testData.map);
    const hydrated = (await hydrateStepReturnValue(
      serialized,
      'run-123',
      undefined
    )) as Map<string, number>;
    expect(hydrated).toBeInstanceOf(Map);
    expect(hydrated.get('a')).toBe(1);
  });

  it('should round-trip nested objects', async () => {
    const serialized = workflow.serialize(testData.nested);
    const hydrated = (await hydrateStepReturnValue(
      serialized,
      'run-123',
      undefined
    )) as any;
    expect(hydrated.items[0]).toBe(1);
    expect(hydrated.items[2]).toBeInstanceOf(Date);
    expect(hydrated.inner.x).toBe(42);
  });
});

describe('old dehydrateStepReturnValue → new workflow.deserialize', () => {
  it('should round-trip primitives', async () => {
    for (const val of testData.primitives) {
      const dehydrated = await dehydrateStepReturnValue(
        val,
        'run-123',
        undefined,
        []
      );
      const deserialized = workflow.deserialize(dehydrated);
      expect(deserialized).toEqual(val);
    }
  });

  it('should round-trip Date', async () => {
    const dehydrated = await dehydrateStepReturnValue(
      testData.date,
      'run-123',
      undefined,
      []
    );
    const deserialized = workflow.deserialize(dehydrated) as Date;
    expect(deserialized).toBeInstanceOf(Date);
    expect(deserialized.toISOString()).toBe('2025-06-15T12:00:00.000Z');
  });

  it('should round-trip nested objects', async () => {
    const dehydrated = await dehydrateStepReturnValue(
      testData.nested,
      'run-123',
      undefined,
      []
    );
    const deserialized = workflow.deserialize(dehydrated) as any;
    expect(deserialized.items[0]).toBe(1);
    expect(deserialized.items[2]).toBeInstanceOf(Date);
  });
});

describe('old dehydrateWorkflowArguments → new workflow.deserialize', () => {
  it('should round-trip when unencrypted', async () => {
    const dehydrated = await dehydrateWorkflowArguments(
      [42, 'hello'],
      'run-123',
      undefined
    );
    const deserialized = workflow.deserialize(dehydrated);
    expect(deserialized).toEqual([42, 'hello']);
  });
});

describe('new client.serialize → old hydrateWorkflowArguments', () => {
  it('should round-trip when unencrypted', async () => {
    const serialized = await client.serialize([42, 'hello']);
    const hydrated = await hydrateWorkflowArguments(
      serialized,
      'run-123',
      undefined
    );
    expect(hydrated).toEqual([42, 'hello']);
  });
});

describe('encryption compat: new step.serialize → old hydrateStepArguments', () => {
  it('should round-trip with encryption', async () => {
    const rawKey = new Uint8Array(32);
    rawKey.fill(0x42);
    const key = await importKey(rawKey);

    const value = { x: 42, date: new Date('2025-01-01') };
    const serialized = await step.serialize(value, key);
    const hydrated = (await hydrateStepArguments(
      serialized,
      'run-123',
      key
    )) as any;
    expect(hydrated.x).toBe(42);
    expect(hydrated.date).toBeInstanceOf(Date);
  });
});

describe('encryption compat: old dehydrateStepArguments → new step.deserialize', () => {
  it('should round-trip with encryption', async () => {
    const rawKey = new Uint8Array(32);
    rawKey.fill(0x42);
    const key = await importKey(rawKey);

    const value = { x: 42, date: new Date('2025-01-01') };
    const dehydrated = await dehydrateStepArguments(value, 'run-123', key);
    const deserialized = (await step.deserialize(dehydrated, key)) as any;
    expect(deserialized.x).toBe(42);
    expect(deserialized.date).toBeInstanceOf(Date);
  });
});
