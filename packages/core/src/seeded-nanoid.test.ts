import seedrandom from 'seedrandom';
import { describe, expect, it } from 'vitest';
import { createSeededNanoid } from './seeded-nanoid.js';

describe('createSeededNanoid', () => {
  // Recorded with nanoid@5.1.6's customRandom(urlAlphabet, 21, ...), which
  // runs recorded before this generator existed used for default hook tokens.
  it('matches the ids and PRNG consumption of nanoid@5.1.6', () => {
    const rng = seedrandom('wrun_test:seed');
    const generate = createSeededNanoid(rng);

    expect(generate()).toBe('pVjvQyygUGbIid9mUBIhp');
    expect(generate()).toBe('mgNKWnMBr9yywfW_syBGT');
    // The next value workflow code would see from Math.random().
    expect(rng()).toBe(0.3399971329395688);
  });

  it('draws 34 values per id', () => {
    let draws = 0;
    const generate = createSeededNanoid(() => {
      draws++;
      return 0.5;
    });

    expect(generate()).toHaveLength(21);
    expect(draws).toBe(34);
  });
});
