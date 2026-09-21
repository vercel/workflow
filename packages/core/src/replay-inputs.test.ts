import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  captureReplayInputs,
  materializeReplayInputs,
  REPLAY_INPUT_LABEL,
  replayInputEnvelope,
} from './replay-inputs.js';
import {
  dehydrateStepArguments,
  hydrateStepArguments,
} from './serialization.js';

function envelope(args: unknown[], indices: number[]) {
  const captures = captureReplayInputs(args, indices)!;
  return {
    captures,
    input: {
      args: args.map((value, i) =>
        indices.includes(i) ? REPLAY_INPUT_LABEL : value
      ),
      replayInputs: replayInputEnvelope(captures),
    },
  };
}

describe('replay input protocol', () => {
  it('captures graph identity, sparse arrays, undefined, negative zero and null prototypes across realms', () => {
    const state = runInNewContext(
      `(() => { const a = Object.create(null); a.items = [, undefined, -0]; a.self = a; return a; })()`
    );
    const { captures, input } = envelope([state, 'ordinary'], [0]);
    state.items.push('later');
    const [value, ordinary] = materializeReplayInputs(input, captures) as any[];
    expect(ordinary).toBe('ordinary');
    expect(value.self).toBe(value);
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value.items).toHaveLength(3);
    expect(0 in value.items).toBe(false);
    expect(1 in value.items).toBe(true);
    expect(Object.is(value.items[2], -0)).toBe(true);
    value.items.push('executor');
    expect(state.items).toHaveLength(4);
  });

  it('preserves an omitted selected argument and its default-parameter semantics', () => {
    const { captures, input } = envelope([], [0]);
    expect(materializeReplayInputs(input, captures)).toEqual([]);
  });

  it('leaves legacy persisted arguments authoritative', () => {
    expect(
      materializeReplayInputs(
        { args: ['recorded'] },
        captureReplayInputs(['new'], [0])
      )
    ).toEqual(['recorded']);
  });

  it.each([
    [-1],
    [0, 0],
    [0.5],
    [NaN],
  ])('rejects invalid indices %j', (indices) => {
    expect(() => captureReplayInputs([{}], indices)).toThrow(
      'distinct non-negative argument indices'
    );
  });

  it.each([
    new Proxy({}, {}),
    new Date(),
    new Map(),
    () => {},
    {
      get value() {
        throw new Error('getter invoked');
      },
    },
    { [Symbol('private')]: 1 },
    new Uint8Array(2),
  ])('rejects values requiring the normal serialization path', (value) => {
    expect(() => captureReplayInputs([value], [0])).toThrow(/replayInputs/);
  });

  it('rejects missing captures, unsupported versions and changed fingerprints', () => {
    const { captures, input } = envelope([{ n: 1 }], [0]);
    expect(() => materializeReplayInputs(input)).toThrow('mismatch');
    expect(() =>
      materializeReplayInputs(input, captureReplayInputs([{ n: 2 }], [0]))
    ).toThrow('mismatch');
    expect(() =>
      materializeReplayInputs(
        { ...input, replayInputs: { ...input.replayInputs, version: 2 } },
        captures
      )
    ).toThrow('mismatch');
  });

  it('serializes constant-sized selected-input envelopes while keeping ordinary inputs', async () => {
    const sizes: number[] = [];
    for (const count of [1, 10, 100]) {
      const { captures, input } = envelope(
        [
          { history: Array(count).fill('private-state-content') },
          { stable: 'persist me' },
        ],
        [0]
      );
      const bytes = (await dehydrateStepArguments(
        input,
        'wrun_replay',
        undefined
      )) as Uint8Array;
      expect(new TextDecoder().decode(bytes)).not.toContain(
        'private-state-content'
      );
      const hydrated = await hydrateStepArguments(
        bytes,
        'wrun_replay',
        undefined
      );
      expect(hydrated.args[0]).toBe(REPLAY_INPUT_LABEL);
      expect(materializeReplayInputs(hydrated, captures)).toEqual([
        { history: Array(count).fill('private-state-content') },
        { stable: 'persist me' },
      ]);
      sizes.push(bytes.byteLength);
    }
    expect(new Set(sizes).size).toBe(1);
  });
});
