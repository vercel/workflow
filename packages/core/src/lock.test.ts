import { describe, it } from 'vitest';

describe('lock', () => {
  it.fails('is only callable inside workflow execution context', () => {
    throw new Error('TODO: implement');
  });

  it.fails('returns a handle with dispose and heartbeat behavior', () => {
    throw new Error('TODO: implement');
  });

  it.fails('allows multiple holders for one key up to the concurrency max', () => {
    throw new Error('TODO: implement');
  });

  it.fails('blocks rate-only locks until the rate window advances', () => {
    throw new Error('TODO: implement');
  });
});
