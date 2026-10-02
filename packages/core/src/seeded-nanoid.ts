/**
 * Deterministic generator for default hook tokens inside workflow code.
 *
 * The output, and the number of values drawn from `random`, are part of the
 * replay contract. Every draw advances the run-seeded PRNG that also feeds
 * `Math.random()` and correlation IDs in workflow code, so a different
 * consumption pattern changes every ID minted after the first `createHook()`,
 * and a run recorded on one version diverges when it is replayed on another.
 *
 * This reproduces `nanoid@5.1.6`'s `customRandom(urlAlphabet, 21, ...)`
 * exactly, instead of depending on nanoid, whose `customRandom` changed how
 * many bytes it requests in 5.1.16. Do not change it.
 */
const URL_ALPHABET =
  'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
const ID_SIZE = 21;
// nanoid 5.1.6 requests ceil(1.6 * mask * size / alphabet.length) bytes per
// batch: ceil(1.6 * 63 * 21 / 64) = 34. With a 64-character alphabet every
// byte maps to a character, so one batch always yields a full id, read from
// the end of the batch.
const BYTES_PER_ID = 34;

export function createSeededNanoid(random: () => number): () => string {
  return () => {
    const bytes = new Uint8Array(BYTES_PER_ID).map(() => 256 * random());
    let id = '';
    for (let i = BYTES_PER_ID - 1; id.length < ID_SIZE; i--) {
      id += URL_ALPHABET[bytes[i] & 63];
    }
    return id;
  };
}
