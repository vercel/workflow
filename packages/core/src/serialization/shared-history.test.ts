import { describe, expect, it } from 'vitest';
import { SharedHistory } from '../shared-history.js';
import { SharedHistoryContext } from './shared-history.js';
import * as workflow from './workflow.js';

function roundtrip(
  value: unknown,
  writer: SharedHistoryContext,
  reader: SharedHistoryContext
) {
  const bytes = workflow.serialize(value, { sharedHistory: writer });
  return {
    bytes,
    value: workflow.deserialize(bytes, { sharedHistory: reader }) as any,
  };
}
describe('shared conversation log protocol', () => {
  it('stores hook content once, references inputs, and recovers the exact old prefix without replay', () => {
    const live = new SharedHistoryContext();
    const hook = roundtrip(
      SharedHistory.source(
        { payload: { message: 'hello'.repeat(14000) } },
        'hook:1'
      ),
      new SharedHistoryContext(),
      live
    );
    expect(SharedHistory.origin(hook.value.payload, 'missing')).toBeUndefined();
    const message = SharedHistory.project(
      { role: 'user', content: hook.value.payload.message },
      {
        content: {
          ...SharedHistory.origin(hook.value.payload)!,
          path: ['payload', 'message'],
        },
      }
    );
    expect(SharedHistory.origin(message, 'content')).toEqual({
      sourceId: 'hook:1',
      path: ['payload', 'message'],
    });
    const delta = SharedHistory.append(
      {
        kind: 'value',
        value: [message, { role: 'assistant', content: 'one' }],
      },
      { logId: 'c', end: 0 },
      2
    );
    const output = roundtrip(delta, live, live);
    expect(output.bytes.length).toBeLessThan(1000);
    const state = SharedHistory.prefix(
      [message, { role: 'assistant', content: 'one' }],
      { logId: 'c', end: 2 }
    );
    const input = roundtrip({ history: state }, live, live);
    expect(input.value.history).toBe(state);
    expect(live.stats.reconstructedPrefixes).toBe(0);
    expect(() =>
      input.value.history.push({ role: 'assistant', content: 'mutation' })
    ).toThrow();
    expect(input.bytes.length).toBeLessThan(300);
    const shallowFrozen = Object.freeze({
      role: 'user',
      content: { text: 'before' },
    });
    SharedHistory.prefix([shallowFrozen], { logId: 'frozen', end: 1 });
    expect(() => {
      shallowFrozen.content.text = 'after';
    }).toThrow();

    // The cold attempt reads committed producer records only; it never runs a step.
    const cold = new SharedHistoryContext();
    cold.ingestPrepared(hook.bytes);
    cold.ingestPrepared(output.bytes);
    const later = SharedHistory.append(
      {
        kind: 'array',
        length: 3,
        set: { '2': { role: 'assistant', content: 'later' } },
      },
      { logId: 'c', end: 2 },
      3
    );
    cold.ingestPrepared(workflow.serialize(later, { sharedHistory: live }));
    const recovered = workflow.deserialize(input.bytes, {
      sharedHistory: cold,
    }) as any;
    expect(recovered.history).toEqual(state);
    expect(recovered.history).toHaveLength(2);
  });
  it('rejects missing, overlapping and non-contiguous committed segments', () => {
    const context = new SharedHistoryContext();
    expect(() =>
      context.revive({ kind: 'prefix', logId: 'x', end: 1 })
    ).toThrow('Incomplete');
    const segment = {
      kind: 'append',
      logId: 'x',
      start: 0,
      end: 1,
      value: { kind: 'array', length: 1, set: {} },
    };
    context.revive(segment);
    expect(() => context.revive(segment)).toThrow('Overlapping');
    expect(() =>
      context.revive({ kind: 'prefix', logId: 'x', end: 1 })
    ).toThrow('Non-contiguous');
  });
});

describe('shared history sources are immutable once revived', () => {
  it('freezes a revived source so an in-place edit cannot diverge from its stored bytes', () => {
    const reader = new SharedHistoryContext();
    const bytes = workflow.serialize(
      SharedHistory.source(
        { payload: { message: 'hi', nested: { n: 1 } } },
        'hook:f'
      ),
      { sharedHistory: new SharedHistoryContext() }
    );
    const value = workflow.deserialize(bytes, { sharedHistory: reader }) as any;
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.payload.nested)).toBe(true);
    expect(() => {
      'use strict';
      value.payload.message = 'edited';
    }).toThrow(TypeError);
  });
});
