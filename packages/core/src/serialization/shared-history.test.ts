import { describe, expect, it } from 'vitest';
import { SharedHistory } from '../shared-history.js';
import { copyStateValue, SharedHistoryContext } from './shared-history.js';
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

describe('shared session state (state cursors)', () => {
  const dict = (o: Record<string, unknown>) =>
    Object.assign(Object.create(null), o);
  const ctx0 = {
    'eve.harness.agentTrace': {
      entries: dict({ a: { kind: 'turn', value: { n: 0 } } }),
    },
    other: 'x'.repeat(2000),
  };

  function steps() {
    // Three committed transitions plus one a concurrent step produced but the
    // session dropped; the chain must skip it.
    const d1 = SharedHistory.stateDelta(
      { kind: 'value', value: ctx0 },
      { logId: 'ctx:s', base: null, version: 'v1' }
    );
    const ctx1 = {
      ...ctx0,
      'eve.harness.agentTrace': {
        entries: dict({
          a: { kind: 'turn', value: { n: 0 } },
          b: { kind: 'checkpoint', value: { big: 'y'.repeat(5000) } },
        }),
      },
    };
    const d2 = SharedHistory.stateDelta(
      {
        kind: 'object',
        patch: {
          'eve.harness.agentTrace': {
            kind: 'object',
            patch: {
              entries: {
                kind: 'object',
                set: { b: ctx1['eve.harness.agentTrace'].entries.b },
              },
            },
          },
        },
      },
      { logId: 'ctx:s', base: 'v1', version: 'v2' }
    );
    const dropped = SharedHistory.stateDelta(
      { kind: 'value', value: { wrong: true } },
      { logId: 'ctx:s', base: 'v2', version: 'vx' }
    );
    const ctx3 = {
      other: ctx0.other,
      'eve.harness.agentTrace': ctx1['eve.harness.agentTrace'],
    };
    const d3 = SharedHistory.stateDelta(
      { kind: 'object', keys: ['other', 'eve.harness.agentTrace'] },
      { logId: 'ctx:s', base: 'v2', version: 'v3' }
    );
    return { outputs: [d1, d2, dropped, d3], ctx3 };
  }

  it('stores later inputs as cursors and reconstructs them from step outputs alone', () => {
    const { outputs, ctx3 } = steps();
    const writer = new SharedHistoryContext();
    const outBytes = outputs.map((d) =>
      workflow.serialize(
        { stateDelta: { serializedContext: d } },
        { sharedHistory: writer }
      )
    );
    // The workflow holds the adopted value at v3 and passes it to the next step.
    const live = SharedHistory.state(ctx3, { logId: 'ctx:s', version: 'v3' });
    const input = workflow.serialize(
      { serializedContext: live },
      { sharedHistory: writer }
    );
    expect(input.byteLength).toBeLessThan(200);
    // Inline: the same context serves the adopted value, as a copy.
    const inline = workflow.deserialize(input, {
      sharedHistory: writer,
    }) as any;
    expect(inline.serializedContext).toStrictEqual(ctx3);
    inline.serializedContext.other = 'edited';
    expect(ctx3.other).toBe(ctx0.other);
    // Cold: a fresh context that only saw the outputs folds the chain.
    const cold = new SharedHistoryContext();
    for (const b of outBytes) workflow.deserialize(b, { sharedHistory: cold });
    const recovered = workflow.deserialize(input, {
      sharedHistory: cold,
    }) as any;
    expect(recovered.serializedContext).toStrictEqual(ctx3);
    expect(Object.keys(recovered.serializedContext)).toEqual([
      'other',
      'eve.harness.agentTrace',
    ]);
    expect(
      Object.getPrototypeOf(
        recovered.serializedContext['eve.harness.agentTrace'].entries
      )
    ).toBe(null);
    expect(SharedHistory.stateCursor(recovered.serializedContext)).toEqual({
      logId: 'ctx:s',
      version: 'v3',
    });
    expect(cold.stats.reconstructedStates).toBe(1);
  });

  it('stores the unrooted starting value in full and recovers through ingestPrepared', () => {
    const { outputs, ctx3 } = steps();
    const writer = new SharedHistoryContext();
    const first = workflow.serialize(
      {
        serializedContext: SharedHistory.state(copyStateValue(ctx0), {
          logId: 'ctx:s',
          version: null,
        }),
      },
      { sharedHistory: writer }
    );
    const firstValue = workflow.deserialize(first, {
      sharedHistory: new SharedHistoryContext(),
    }) as any;
    expect(firstValue.serializedContext).toStrictEqual(ctx0);
    expect(SharedHistory.stateCursor(firstValue.serializedContext)).toEqual({
      logId: 'ctx:s',
      version: null,
    });
    const outBytes = outputs.map((d) =>
      workflow.serialize(
        { stateDelta: { serializedContext: d } },
        { sharedHistory: writer }
      )
    );
    const input = workflow.serialize(
      {
        serializedContext: SharedHistory.state(ctx3, {
          logId: 'ctx:s',
          version: 'v3',
        }),
      },
      { sharedHistory: writer }
    );
    const cold = new SharedHistoryContext();
    for (const b of outBytes) cold.ingestPrepared(b);
    const got = (workflow.deserialize(input, { sharedHistory: cold }) as any)
      .serializedContext;
    expect(got).toStrictEqual(ctx3);
  });

  it('writes the value in full where the context cannot resolve the cursor (another run)', () => {
    const value = SharedHistory.state(
      { a: 'x'.repeat(3000) },
      { logId: 'ctx:s', version: 'elsewhere' }
    );
    const bytes = workflow.serialize(
      { v: value },
      { sharedHistory: new SharedHistoryContext() }
    );
    const back = workflow.deserialize(bytes, {
      sharedHistory: new SharedHistoryContext(),
    }) as any;
    expect(back.v).toStrictEqual({ a: 'x'.repeat(3000) });
    expect(SharedHistory.stateCursor(back.v)).toEqual({
      logId: 'ctx:s',
      version: null,
    });
    const arr = SharedHistory.prefix([{ m: 1 }, { m: 2 }], {
      logId: 'conv:s',
      end: 2,
    });
    const pb = workflow.deserialize(
      workflow.serialize(
        { h: arr },
        { sharedHistory: new SharedHistoryContext() }
      ),
      { sharedHistory: new SharedHistoryContext() }
    ) as any;
    expect(pb.h).toStrictEqual([{ m: 1 }, { m: 2 }]);
  });

  it('fails explicitly when a version is missing', () => {
    const writer = new SharedHistoryContext();
    workflow.serialize(
      {
        d: SharedHistory.stateDelta(
          { kind: 'value', value: { a: 1 } },
          { logId: 'ctx:s', base: null, version: 'nope' }
        ),
      },
      { sharedHistory: writer }
    );
    const input = workflow.serialize(
      { s: SharedHistory.state({ a: 1 }, { logId: 'ctx:s', version: 'nope' }) },
      { sharedHistory: writer }
    );
    expect(() =>
      workflow.deserialize(input, { sharedHistory: new SharedHistoryContext() })
    ).toThrow(/Missing state version/);
  });
});
