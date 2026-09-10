/**
 * Tests for the VM-compatible workflow serializer.
 *
 * Verifies that:
 * 1. The VM serializer produces the same wire format as the Node.js serializer.
 * 2. Data serialized by the VM can be deserialized by Node.js and vice versa.
 */

import { describe, expect, it } from 'vitest';
import { peekFormatPrefix } from './format.js';
import {
  deserialize as nodeDeserialize,
  serialize as nodeSerialize,
} from './workflow.js';
import {
  deserialize as vmDeserialize,
  serialize as vmSerialize,
} from './workflow-vm.js';

describe('VM workflow serializer', () => {
  it('should produce format-prefixed output', () => {
    const serialized = vmSerialize(42);
    expect(serialized).toBeInstanceOf(Uint8Array);
    expect(peekFormatPrefix(serialized)).toBe('devl');
  });

  it('should round-trip primitives', () => {
    for (const val of [42, 'hello', true, null, undefined]) {
      expect(vmDeserialize(vmSerialize(val))).toEqual(val);
    }
  });

  it('should round-trip Date', () => {
    const date = new Date('2025-01-01T00:00:00Z');
    const result = vmDeserialize(vmSerialize(date)) as Date;
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('should round-trip Map', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const result = vmDeserialize(vmSerialize(map)) as Map<string, number>;
    expect(result).toBeInstanceOf(Map);
    expect(result.get('a')).toBe(1);
  });

  it('should round-trip Uint8Array', () => {
    const u8 = new Uint8Array([1, 2, 3, 4, 5]);
    const result = vmDeserialize(vmSerialize(u8)) as Uint8Array;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should round-trip nested objects', () => {
    const val = { a: 1, b: [2, new Date('2025-01-01')], c: { d: 'e' } };
    const result = vmDeserialize(vmSerialize(val)) as any;
    expect(result.a).toBe(1);
    expect(result.b[0]).toBe(2);
    expect(result.b[1]).toBeInstanceOf(Date);
    expect(result.c.d).toBe('e');
  });

  it('should round-trip WorkflowFunction reference', () => {
    // Simulate an SWC-compiled workflow function: a function with a
    // `workflowId` property that the runtime treats as an opaque handle.
    const fn = Object.assign(() => {}, {
      workflowId: 'workflow//./src/foo//myWorkflow',
    });
    const revived = vmDeserialize(vmSerialize(fn)) as any;
    expect(typeof revived).toBe('function');
    expect(revived.workflowId).toBe('workflow//./src/foo//myWorkflow');
    // Calling the revived stub throws — workflow functions must be invoked
    // via start(), not directly.
    expect(() => revived()).toThrow(/Use start\(\)/);
  });

  it('should round-trip DOMException', () => {
    const ex = new DOMException('boom', 'AbortError');
    const revived = vmDeserialize(vmSerialize(ex)) as Error;
    // The revived value is a DOMException (or Error fallback with the same
    // name) — either way it should preserve name/message and be instanceof Error.
    expect(revived).toBeInstanceOf(Error);
    expect(revived.name).toBe('AbortError');
    expect(revived.message).toBe('boom');
  });
});

describe('VM ↔ Node.js cross-compatibility', () => {
  it('VM serialize → Node.js deserialize', () => {
    const values = [
      42,
      'hello',
      new Date('2025-06-15'),
      new Map([['x', 1]]),
      new Set([1, 2, 3]),
      new Uint8Array([10, 20, 30]),
      { nested: { arr: [1, 2, 3] } },
    ];
    for (const val of values) {
      const vmBytes = vmSerialize(val);
      const nodeResult = nodeDeserialize(vmBytes);
      const vmResult = vmDeserialize(vmBytes);
      // Both should produce equivalent values
      expect(JSON.stringify(nodeResult)).toBe(JSON.stringify(vmResult));
    }
  });

  it('Node.js serialize → VM deserialize', () => {
    const values = [
      42,
      'hello',
      new Date('2025-06-15'),
      new Map([['x', 1]]),
      new Set([1, 2, 3]),
      new Uint8Array([10, 20, 30]),
      { nested: { arr: [1, 2, 3] } },
    ];
    for (const val of values) {
      const nodeBytes = nodeSerialize(val);
      const vmResult = vmDeserialize(nodeBytes);
      const nodeResult = nodeDeserialize(nodeBytes);
      expect(JSON.stringify(vmResult)).toBe(JSON.stringify(nodeResult));
    }
  });

  it('step args format: VM serialize → Node.js hydrateStepArguments', async () => {
    // This is the critical path: VM serializes step args, step handler deserializes
    const { hydrateStepArguments } = await import('../serialization.js');

    const stepInput = { args: [10, 7], closureVars: { x: 42 } };
    const vmBytes = vmSerialize(stepInput);

    const hydrated = (await hydrateStepArguments(
      vmBytes,
      'run-123',
      undefined
    )) as any;
    expect(hydrated.args).toEqual([10, 7]);
    expect(hydrated.closureVars).toEqual({ x: 42 });
  });

  it('Node.js serialize TypeError → VM deserialize keeps subclass identity + cause', () => {
    const cause = new TypeError('underlying');
    const wrapped = new Error('outer');
    (wrapped as any).cause = cause;
    const nodeBytes = nodeSerialize(wrapped);
    const result = vmDeserialize(nodeBytes) as Error;
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('outer');
    expect((result as any).cause).toBeInstanceOf(TypeError);
    expect(((result as any).cause as Error).message).toBe('underlying');
  });

  it('Node.js serialize built-in subclasses → VM deserialize preserves type identity', () => {
    const cases: Array<[Error, new (...args: any[]) => Error]> = [
      [new TypeError('t'), TypeError],
      [new RangeError('r'), RangeError],
      [new SyntaxError('s'), SyntaxError],
      [new ReferenceError('rf'), ReferenceError],
    ];
    for (const [err, ctor] of cases) {
      const result = vmDeserialize(nodeSerialize(err)) as Error;
      expect(result).toBeInstanceOf(ctor);
      expect(result.message).toBe(err.message);
    }
  });

  it('step result format: Node.js dehydrateStepReturnValue → VM deserialize', async () => {
    // This is the other critical path: step handler serializes result, VM deserializes
    const { dehydrateStepReturnValue } = await import('../serialization.js');

    const result = { sum: 17, computed: true };
    const nodeBytes = await dehydrateStepReturnValue(
      result,
      'run-123',
      undefined,
      []
    );
    const vmResult = vmDeserialize(nodeBytes) as any;
    expect(vmResult.sum).toBe(17);
    expect(vmResult.computed).toBe(true);
  });
});
