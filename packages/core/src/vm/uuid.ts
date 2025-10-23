/**
 * Returns a function that generates a random UUID, based on the given RNG.
 *
 * `rng` is expected to be a seeded random number generator (i.e. `seedrandom.PRNG` instance).
 *
 * @param rng - A function that returns a random number between 0 and 1.
 * @returns A `crypto.randomUUID`-like function.
 */
export function createRandomUUID(rng: () => number) {
  return function randomUUID(): ReturnType<typeof crypto.randomUUID> {
    const chars = '0123456789abcdef';
    let uuid = '';
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        uuid += '-';
      } else if (i === 14) {
        uuid += '4'; // Version 4 UUID
      } else if (i === 19) {
        uuid += chars[Math.floor(rng() * 4) + 8]; // 8, 9, a, or b
      } else {
        uuid += chars[Math.floor(rng() * 16)];
      }
    }
    return uuid as ReturnType<typeof crypto.randomUUID>;
  };
}
