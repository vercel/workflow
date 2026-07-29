import { decodeTime, monotonicFactory } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  createCorrelationIdGenerator,
  deriveHookToken,
  fingerprintValue,
} from './correlation-id.js';

const SEED = 'wrun_01ABC:workflow//./a//run:dpl_1';
const FIXED_TIMESTAMP = 1_785_179_149_659;

/** A generator wired the way `runWorkflow` wires one, for a fresh replay. */
function generator(options: { callSiteScoped: boolean; seed?: string }) {
  // A deterministic stand-in for the VM's seeded `Math.random`. Two replays of
  // the same run see the same sequence, which is what makes the positional
  // scheme replay-stable in the first place.
  let state = 1;
  const random = () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
  const ulid = monotonicFactory(random);
  return createCorrelationIdGenerator({
    seed: options.seed ?? SEED,
    fixedTimestamp: FIXED_TIMESTAMP,
    positional: () => ulid(FIXED_TIMESTAMP),
    callSiteScoped: options.callSiteScoped,
  });
}

describe('createCorrelationIdGenerator', () => {
  describe('id shape', () => {
    it('mints ids the backend accepts as ULIDs, carrying fixedTimestamp', () => {
      const generate = generator({ callSiteScoped: true });
      for (const scope of ['step a []', 'wait', 'hook', 'attr']) {
        const id = generate(scope);
        expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(decodeTime(id)).toBe(FIXED_TIMESTAMP);
      }
    });

    it('matches the positional scheme’s shape', () => {
      const positional = generator({ callSiteScoped: false })('step a []');
      const scoped = generator({ callSiteScoped: true })('step a []');
      expect(scoped).toHaveLength(positional.length);
      expect(decodeTime(scoped)).toBe(decodeTime(positional));
    });
  });

  describe('positional scheme (default)', () => {
    it('ignores scopes and returns the monotonic sequence', () => {
      const a = generator({ callSiteScoped: false });
      const b = generator({ callSiteScoped: false });
      // Same draw order ⇒ same ids, whatever the scopes say.
      expect([a('step x []'), a('wait'), a('step y []')]).toEqual([
        b('wait'),
        b('step q []'),
        b('hook'),
      ]);
    });

    it('is what makes ids positional: one extra draw renames everything after', () => {
      const canonical = generator({ callSiteScoped: false });
      const stale = generator({ callSiteScoped: false });
      canonical('step finalize []');
      canonical('step finalize []');
      canonical('step finalize []');
      stale('step finalize []');
      stale('step finalize []');
      // Both replays now call the same step for the first time, and disagree.
      expect(canonical('step recover []')).not.toBe(stale('step recover []'));
    });
  });

  describe('call-site scheme', () => {
    it('gives two replays the same id for the same call, after a prefix disagreement', () => {
      const canonical = generator({ callSiteScoped: true });
      const stale = generator({ callSiteScoped: true });
      canonical('step finalize []');
      canonical('step finalize []');
      canonical('step finalize []');
      stale('step finalize []');
      stale('step finalize []');
      // This is the whole point: a replay that saw one fewer `finalize` still
      // addresses `recover` call #1 identically, so a late write collides with
      // the canonical entity instead of renaming every entity after it.
      expect(canonical('step recover []')).toBe(stale('step recover []'));
    });

    it('separates repeated calls to one scope by an ordinal', () => {
      const generate = generator({ callSiteScoped: true });
      const ids = [
        generate('step a []'),
        generate('step a []'),
        generate('step a []'),
      ];
      expect(new Set(ids).size).toBe(3);
    });

    it('separates scopes from each other', () => {
      const generate = generator({ callSiteScoped: true });
      expect(generate('step a []')).not.toBe(generate('step b []'));
      expect(generate('wait')).not.toBe(generate('attr'));
    });

    it('separates runs: the same call in two runs gets different ids', () => {
      const a = generator({ callSiteScoped: true, seed: SEED });
      const b = generator({ callSiteScoped: true, seed: `${SEED}x` });
      expect(a('step a []')).not.toBe(b('step a []'));
    });

    it('does not draw from the run PRNG, so unrelated draws cannot shift ids', () => {
      // Two replays that made a different number of *stream id* draws (which
      // keep using the positional sequence) still agree on correlation ids.
      let drawsA = 0;
      const a = createCorrelationIdGenerator({
        seed: SEED,
        fixedTimestamp: FIXED_TIMESTAMP,
        positional: () => {
          drawsA++;
          return 'unused';
        },
        callSiteScoped: true,
      });
      expect(a('step a []')).toBe(
        generator({ callSiteScoped: true })('step a []')
      );
      expect(drawsA).toBe(0);
    });

    it('spreads ids across the id space rather than clustering', () => {
      const generate = generator({ callSiteScoped: true });
      const randomParts = Array.from({ length: 200 }, (_, i) =>
        generate(`step s${i} []`).slice(10)
      );
      expect(new Set(randomParts).size).toBe(randomParts.length);
      // A hash with poor diffusion would leave a shared prefix across
      // near-identical scope strings.
      expect(
        new Set(randomParts.map((part) => part.slice(0, 4))).size
      ).toBeGreaterThan(150);
    });
  });
});

describe('fingerprintValue', () => {
  it('separates different arguments and matches equal ones', () => {
    expect(fingerprintValue([1, 'a'])).toBe(fingerprintValue([1, 'a']));
    expect(fingerprintValue([1, 'a'])).not.toBe(fingerprintValue([1, 'b']));
    expect(fingerprintValue([])).not.toBe(fingerprintValue([undefined]));
  });

  it('does not throw on values JSON cannot serialize', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => fingerprintValue([cyclic])).not.toThrow();
    expect(() => fingerprintValue([1n])).not.toThrow();
    expect(fingerprintValue([1n])).not.toBe(fingerprintValue([2n]));
  });

  it('is stable for a value that survives a serialization round trip', () => {
    const args = [{ b: 2, nested: [1, 2, 3] }, 'x'];
    expect(fingerprintValue(args)).toBe(
      fingerprintValue(JSON.parse(JSON.stringify(args)))
    );
  });
});

describe('deriveHookToken', () => {
  it('is deterministic per (seed, correlationId) and long enough to be unguessable', () => {
    const id = 'hook_01ABCDEFGHJKMNPQRSTVWXYZ00';
    expect(deriveHookToken(SEED, id)).toBe(deriveHookToken(SEED, id));
    expect(deriveHookToken(SEED, id)).toHaveLength(21);
    expect(deriveHookToken(SEED, id)).not.toBe(deriveHookToken(`${SEED}x`, id));
    expect(deriveHookToken(SEED, id)).not.toBe(
      deriveHookToken(SEED, `${id.slice(0, -1)}1`)
    );
  });
});
