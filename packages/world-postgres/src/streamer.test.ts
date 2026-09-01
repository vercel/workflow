import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drizzle } from './drizzle/index.js';
import { createStreamer } from './streamer.js';

const pgClient = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  end: vi.fn(async () => {}),
  on: vi.fn(),
  query: vi.fn(async () => ({ rows: [] })),
  removeListener: vi.fn(),
}));
const createPgClient = vi.hoisted(() => vi.fn());

vi.mock('pg', () => ({
  Client: class MockClient {
    connect = pgClient.connect;
    end = pgClient.end;
    on = pgClient.on;
    query = pgClient.query;
    removeListener = pgClient.removeListener;

    constructor(options: unknown) {
      createPgClient(options);
    }
  },
}));

describe('Postgres streamer listener lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not open a database connection until a stream is read', async () => {
    const streamer = createStreamer({ options: {} } as Pool, {} as Drizzle);

    expect(createPgClient).not.toHaveBeenCalled();
    await streamer.close();
    expect(createPgClient).not.toHaveBeenCalled();
  });

  it('shares the lazy listener with readable streams', async () => {
    const query = {
      from: vi.fn(),
      orderBy: vi.fn(async () => []),
      where: vi.fn(),
    };
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const drizzle = {
      select: vi.fn(() => query),
    } as unknown as Drizzle;
    const streamer = createStreamer({ options: {} } as Pool, drizzle);

    const first = await streamer.streams.get('wrun_1', 'stream');
    const second = await streamer.streams.get('wrun_1', 'stream');
    await vi.waitFor(() => expect(pgClient.connect).toHaveBeenCalledOnce());

    await Promise.all([first.cancel(), second.cancel()]);
    await streamer.close();
    expect(createPgClient).toHaveBeenCalledOnce();
    expect(pgClient.query).toHaveBeenCalledWith('LISTEN workflow_event_chunk');
    expect(pgClient.query).toHaveBeenCalledWith(
      'UNLISTEN workflow_event_chunk'
    );
  });
});
