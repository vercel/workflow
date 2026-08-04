import { decodeTime } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  CORRELATION_ID_LENGTH,
  type CorrelationIdKind,
  createCorrelationIdGenerator,
} from './correlation-id.js';

const SEED = 'wrun_abc:myWorkflow:dpl_123';
const FIXED_TIMESTAMP = 1753481739458;

function makeGenerator(
  overrides: { seed?: string; fixedTimestamp?: number } = {}
) {
  return createCorrelationIdGenerator({
    seed: overrides.seed ?? SEED,
    fixedTimestamp: overrides.fixedTimestamp ?? FIXED_TIMESTAMP,
  });
}

const KINDS: CorrelationIdKind[] = [
  'step',
  'wait',
  'hook',
  'attr',
  'abort',
  'abortHook',
  'stream',
];

describe('createCorrelationIdGenerator', () => {
  it('mints syntactically valid ULIDs carrying fixedTimestamp', () => {
    const generate = makeGenerator();
    for (const kind of KINDS) {
      const id = generate(kind);
      expect(id).toHaveLength(CORRELATION_ID_LENGTH);
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
      expect(decodeTime(id)).toBe(FIXED_TIMESTAMP);
    }
  });

  it('is deterministic across replays of the same run', () => {
    const first = makeGenerator();
    const second = makeGenerator();
    const draw = (generate: (kind: CorrelationIdKind) => string) => [
      generate('step'),
      generate('step'),
      generate('wait'),
      generate('step'),
      generate('hook'),
    ];
    expect(draw(first)).toEqual(draw(second));
  });

  it('mints different ids for different runs', () => {
    const first = makeGenerator({ seed: 'wrun_one:w:dpl' });
    const second = makeGenerator({ seed: 'wrun_two:w:dpl' });
    expect(first('step')).not.toBe(second('step'));
  });

  it('gives every kind its own starting point', () => {
    const generate = makeGenerator();
    const ids = KINDS.map((kind) => generate(kind));
    expect(new Set(ids).size).toBe(KINDS.length);
  });

  it('increases monotonically within a kind', () => {
    const generate = makeGenerator();
    const ids = [generate('hook'), generate('hook'), generate('hook')];
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not renumber one kind when another draws more often', () => {
    // The whole point of per-kind sources: two replays that disagree about how
    // many hooks, sleeps or streams were created still agree about which id
    // belongs to the Nth step.
    const withoutExtras = makeGenerator();
    const withExtras = makeGenerator();

    const steps = [withoutExtras('step'), withoutExtras('step')];

    withExtras('hook');
    const interleaved = [withExtras('step')];
    withExtras('wait');
    withExtras('stream');
    withExtras('attr');
    withExtras('abort');
    interleaved.push(withExtras('step'));

    expect(interleaved).toEqual(steps);
  });

  it('keeps abort controllers from renumbering user hooks', () => {
    const withoutController = makeGenerator();
    const withController = makeGenerator();
    withController('abort');
    withController('abortHook');
    expect(withController('hook')).toBe(withoutController('hook'));
  });

  it('keeps every id on fixedTimestamp', () => {
    // Stream ids are drawn without a seed time of their own. Drawn from a raw
    // `monotonicFactory` they would latch the host wall clock into `lastTime`
    // and every later id in the run would carry a timestamp that differs per
    // replay, so they go through this generator like every other kind.
    const generate = makeGenerator();
    for (const kind of ['stream', 'stream', 'step', 'hook'] as const) {
      expect(decodeTime(generate(kind))).toBe(FIXED_TIMESTAMP);
    }
  });
});
