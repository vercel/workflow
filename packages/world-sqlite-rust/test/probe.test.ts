// End-to-end checks of the temporary host probe: Node calls Rust, Rust runs a
// SQLite statement, and binary data or a typed error comes back. Delete this
// file together with `echo`.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorld } from '@workflow/world-sqlite-rust';
import { expect, test } from 'vitest';

async function withDirectory(fn: (directory: string) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-sqlite-'));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// @lat: [[world-sqlite#Node binding#Buffers]]
test('echo returns binary values through SQLite as new Buffers', () =>
  withDirectory((directory) => {
    const world = createWorld({ dataDir: directory });
    const input = Buffer.from([0, 1, 0, 255, 254]);
    const output = world.echo(input);
    expect(Buffer.isBuffer(output)).toBe(true);
    expect(output.equals(input)).toBe(true);
    output.fill(9);
    expect([...input]).toEqual([0, 1, 0, 255, 254]);
    expect(world.echo(Buffer.alloc(0)).length).toBe(0);
    const large = Buffer.alloc(1_000_000, 7);
    expect(world.echo(large).equals(large)).toBe(true);
  }));

// @lat: [[world-sqlite#Node binding#Errors]]
test('throws SQLite failures in the shape of node:sqlite errors', () =>
  withDirectory(async (directory) => {
    const file = join(directory, 'world.db');
    await mkdir(file);
    let expected: Error & { errcode?: number; errstr?: string };
    try {
      new DatabaseSync(file).close();
      throw new Error('node:sqlite opened a directory');
    } catch (error) {
      expected = error as typeof expected;
    }
    let actual: typeof expected | undefined;
    try {
      createWorld({ dataDir: directory }).echo(Buffer.alloc(0));
    } catch (error) {
      actual = error as typeof expected;
    }
    expect(actual).toBeInstanceOf(Error);
    expect(actual).toMatchObject({
      code: expected.code,
      errcode: expected.errcode,
      errstr: expected.errstr,
    });
    expect(actual?.message.startsWith(expected.message)).toBe(true);
  }));
