import { describe, it } from 'vitest';

describe('limits schemas', () => {
  it.fails('accepts concurrency-only, rate-only, and combined limit definitions', () => {
    throw new Error('TODO: implement');
  });

  it.fails('rejects invalid or empty limit definitions', () => {
    throw new Error('TODO: implement');
  });

  it.fails('discriminates acquired and blocked acquire results', () => {
    throw new Error('TODO: implement');
  });

  it.fails('keeps lease, release, and heartbeat request shapes stable', () => {
    throw new Error('TODO: implement');
  });
});
