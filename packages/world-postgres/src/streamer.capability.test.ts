import { describe, expect, it, vi } from 'vitest';

vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  return {
    ...actual,
    Client: class {
      on() {}
      removeListener() {}
      async connect() {}
      async query() {}
      async end() {}
    },
  };
});

import { createStreamer } from './streamer.js';

describe('Postgres keyed stream append capability', () => {
  it('stays unavailable without the required service-backed ordering proof', () => {
    const streamer = createStreamer({} as any, {} as any);

    expect(streamer.keyedStreamAppendVersion).toBeUndefined();
  });
});
