import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Db } from './db.js';
import { createStreamer } from './streamer.js';

let directory: string;
let db: Db;
let otherDb: Db;
const runId = 'wrun_test12345678901234';
const name = 'cross-connection';

beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(path.join(os.tmpdir(), 'sqlite-stream-race-'));
  const file = path.join(directory, 'workflow.sqlite');
  db = new Db(file);
  otherDb = new Db(file);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
  otherDb.close();
  rmSync(directory, { recursive: true, force: true });
});

it('polls a commit made between the backlog read and version capture', async () => {
  const originalAll = db.all.bind(db);
  let injected = false;
  vi.spyOn(db, 'all').mockImplementation((sql, ...params) => {
    const rows = originalAll(sql, ...params);
    if (!injected && sql.includes('SELECT chunk_id, eof, data')) {
      injected = true;
      otherDb.run(
        'INSERT INTO stream_chunks (stream_name, chunk_id, tag, eof, data) VALUES (?, ?, ?, ?, ?)',
        name,
        'chnk_00000000000000000000000001',
        '',
        0,
        new TextEncoder().encode('remote')
      );
    }
    return rows;
  });
  const reader = (
    await createStreamer(db).streams.get(runId, name)
  ).getReader();
  const received: string[] = [];
  const pending = reader.read().then(({ value }) => {
    if (value) received.push(new TextDecoder().decode(value));
  });
  await vi.advanceTimersByTimeAsync(350);
  await reader.cancel();
  await pending;
  expect(injected).toBe(true);
  expect(received).toEqual(['remote']);
});

it('drains remote chunks before a local EOF notification', async () => {
  const local = createStreamer(db);
  const remote = createStreamer(otherDb);
  const reader = (await local.streams.get(runId, name)).getReader();
  await remote.streams.write(runId, name, 'remote');
  await local.streams.close(runId, name);
  const received: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received.push(new TextDecoder().decode(value));
  }
  expect(received).toEqual(['remote']);
});

it('drains remote and local chunks in order without duplicates', async () => {
  const local = createStreamer(db);
  const remote = createStreamer(otherDb);
  const reader = (await local.streams.get(runId, name)).getReader();
  await remote.streams.write(runId, name, 'remote');
  await local.streams.writeMulti!(runId, name, ['local-one', 'local-two']);
  await vi.advanceTimersByTimeAsync(350);
  await local.streams.close(runId, name);
  const received: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received.push(new TextDecoder().decode(value));
  }
  expect(received).toEqual(['remote', 'local-one', 'local-two']);
});
