import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDataDir } from './init.js';

// Bun's opendir() resolves for a directory that does not exist and rejects
// on the first read instead, where Node rejects opendir() itself. This file
// runs every opendir() the way Bun does.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const opendir: typeof actual.opendir = async (dirPath, options) => {
    try {
      return await actual.opendir(dirPath, options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
      } as unknown as Awaited<ReturnType<typeof actual.opendir>>;
    }
  };
  return { ...actual, opendir };
});

describe('initDataDir where opendir() reports a missing directory on read', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = path.join(
      tmpdir(),
      `workflow-init-lazy-opendir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('initializes a new data directory', async () => {
    await initDataDir(dataDir);
    expect(existsSync(path.join(dataDir, 'version.txt'))).toBe(true);
  });

  it('initializes a data directory that has only some entity directories', async () => {
    mkdirSync(path.join(dataDir, 'events', 'wrun_A'), { recursive: true });
    await initDataDir(dataDir);
    expect(readFileSync(path.join(dataDir, 'version.txt'), 'utf-8')).toMatch(
      /^@workflow\/world-local@/
    );
  });
});
