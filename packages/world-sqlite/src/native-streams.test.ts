import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { NativeSqliteWorld } from './native.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'workflow-world-sqlite-native-streams-')
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

it('round-trips stream byte views through the native binding', async () => {
  const databasePath = path.join(await temporaryDirectory(), 'world.sqlite');
  const native = new NativeSqliteWorld(databasePath);
  await native.migrate();
  await native.createEvent(
    'wrun_native_streams',
    'run_created',
    7,
    0,
    undefined,
    undefined,
    new Uint8Array(),
    'local-js',
    'workflow//native-streams',
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined
  );

  const firstBacking = new Uint8Array([255, 1, 2, 254]);
  const secondBacking = new Uint8Array([253, 3, 4, 252]);
  const write = native.writeStreamChunks('wrun_native_streams', 'output', [
    firstBacking.subarray(1, 3),
    secondBacking.subarray(1, 3),
    new Uint8Array(),
  ]);
  firstBacking.fill(9);
  secondBacking.fill(9);
  await write;

  const first = await native.getStreamChunks(
    'wrun_native_streams',
    'output',
    undefined,
    2
  );
  expect(first).toMatchObject({
    cursor: 'index:2',
    hasMore: true,
    done: false,
  });
  expect(
    first.data.map(({ index, data }) => [index, Array.from(data)])
  ).toEqual([
    [0, [1, 2]],
    [1, [3, 4]],
  ]);

  await native.closeStream('wrun_native_streams', 'output');
  const second = await native.getStreamChunks(
    'wrun_native_streams',
    'output',
    first.cursor ?? undefined,
    2
  );
  expect(second).toMatchObject({ cursor: null, hasMore: false, done: true });
  expect(second.data).toHaveLength(1);
  expect(second.data[0]?.index).toBe(2);
  expect(Array.from(second.data[0]?.data ?? [])).toEqual([]);
  await expect(native.listStreams('wrun_native_streams')).resolves.toEqual([
    'output',
  ]);
  await expect(
    native.getStreamInfo('wrun_native_streams', 'output')
  ).resolves.toEqual({ tailIndex: 2, done: true });
  await expect(
    native.writeStreamChunks('wrun_native_streams', 'output', [
      new Uint8Array([5]),
    ])
  ).rejects.toThrow(/already closed/);

  expect(native.close()).toBe(true);
});
