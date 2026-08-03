import { decodeTime, monotonicFactory } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  CORRELATION_ID_LENGTH,
  type CorrelationIdKind,
  createCorrelationIdGenerator,
  isPerKindCorrelationIdsEnabled,
} from './correlation-id.js';

const SEED = 'wrun_abc:myWorkflow:dpl_123';
const FIXED_TIMESTAMP = 1753481739458;

function makeGenerator(
  overrides: { seed?: string; fixedTimestamp?: number; perKind?: boolean } = {}
) {
  // A stand-in for the run's shared sequence. Seeded so the positional mode is
  // reproducible across the two generators a replay-stability test builds.
  let counter = 0;
  const ulid = monotonicFactory(() => {
    counter = (counter * 1103515245 + 12345) % 2147483648;
    return counter / 2147483648;
  });
  const fixedTimestamp = overrides.fixedTimestamp ?? FIXED_TIMESTAMP;
  return createCorrelationIdGenerator({
    seed: overrides.seed ?? SEED,
    fixedTimestamp,
    positional: () => ulid(fixedTimestamp),
    perKind: overrides.perKind ?? true,
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

  it('keeps every id on fixedTimestamp in both modes', () => {
    // `monotonicFactory` returns `encodeTime(lastTime)` on its increment branch,
    // so a single draw that omits the seed time latches the host wall clock and
    // every later id in the run carries a timestamp that differs per replay.
    // Stream ids used to be drawn that way.
    for (const perKind of [true, false]) {
      const generate = makeGenerator({ perKind });
      for (const kind of ['stream', 'stream', 'step', 'hook'] as const) {
        expect(decodeTime(generate(kind))).toBe(FIXED_TIMESTAMP);
      }
    }
  });

  it('ignores the kind when per-kind sources are disabled', () => {
    const generate = makeGenerator({ perKind: false });
    const shared = makeGenerator({ perKind: false });
    // Positional mode is one sequence for the whole run, so drawing `wait`
    // consumes the ordinal the next `step` would otherwise have had.
    expect(generate('step')).toBe(shared('step'));
    expect(generate('wait')).toBe(shared('step'));
  });
});

describe('isPerKindCorrelationIdsEnabled', () => {
  it('reads WORKFLOW_PER_KIND_CORRELATION_IDS, defaulting to enabled', () => {
    const original = process.env.WORKFLOW_PER_KIND_CORRELATION_IDS;
    try {
      delete process.env.WORKFLOW_PER_KIND_CORRELATION_IDS;
      expect(isPerKindCorrelationIdsEnabled()).toBe(true);
      process.env.WORKFLOW_PER_KIND_CORRELATION_IDS = '1';
      expect(isPerKindCorrelationIdsEnabled()).toBe(true);
      process.env.WORKFLOW_PER_KIND_CORRELATION_IDS = '0';
      expect(isPerKindCorrelationIdsEnabled()).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.WORKFLOW_PER_KIND_CORRELATION_IDS;
      } else {
        process.env.WORKFLOW_PER_KIND_CORRELATION_IDS = original;
      }
    }
  });
});
