import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LockOptions } from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStreamer } from './streamer.js';

// The stream index lock's failure paths, which a real lock only reaches after
// 15s of retries or a stalled holder.
const lockfile = vi.hoisted(() => ({ lock: vi.fn() }));
vi.mock('proper-lockfile', () => lockfile);

const RUN_ID = 'wrun_indexlock';

describe('stream index lock failures', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamer-lock-test-'));
    lockfile.lock.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('registers the stream without the lock when the lock cannot be taken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    lockfile.lock.mockRejectedValue(
      Object.assign(new Error('Lock file is already being held'), {
        code: 'ELOCKED',
      })
    );
    const streamer = createStreamer(testDir);

    await streamer.writeToStream('first', RUN_ID, 'a');
    await streamer.writeToStream('second', RUN_ID, 'a');
    await streamer.writeToStream('first', RUN_ID, 'b');

    expect((await streamer.listStreamsByRunId(RUN_ID)).sort()).toEqual([
      'first',
      'second',
    ]);
    // Warned once, and each stream tried the lock only on its first write.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lockfile.lock).toHaveBeenCalledTimes(2);
  });

  it('checks the index again on the next write after the lock was compromised', async () => {
    const release = vi.fn(async () => {});
    lockfile.lock
      .mockImplementationOnce(async (_file: string, options: LockOptions) => {
        options.onCompromised?.(new Error('Unable to update lock'));
        return release;
      })
      .mockResolvedValue(release);
    const streamer = createStreamer(testDir);

    await streamer.writeToStream('stream', RUN_ID, 'a');
    expect(await streamer.listStreamsByRunId(RUN_ID)).toEqual(['stream']);
    // A compromised lock is not released: proper-lockfile already dropped it.
    expect(release).not.toHaveBeenCalled();

    await streamer.writeToStream('stream', RUN_ID, 'b');
    await streamer.writeToStream('stream', RUN_ID, 'c');

    expect(lockfile.lock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await streamer.listStreamsByRunId(RUN_ID)).toEqual(['stream']);
  });
});
