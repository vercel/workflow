import { describe, expect, it, vi } from 'vitest';
import { createBuildQueue } from './build-queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createBuildQueue', () => {
  it('merges every build requested during a running build into one follow-up build', async () => {
    const enqueue = createBuildQueue();
    const first = deferred();
    const build = vi.fn(() => first.promise);

    const running = enqueue(build);
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
    const waiting = Array.from({ length: 30 }, () => enqueue(build));
    first.resolve();
    await Promise.all([running, ...waiting]);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('merges builds requested before the queue starts them', async () => {
    const enqueue = createBuildQueue();
    const build = vi.fn(async () => {});

    await Promise.all([enqueue(build), enqueue(build), enqueue(build)]);

    expect(build).toHaveBeenCalledOnce();
  });

  it('runs the most recent of the merged tasks', async () => {
    const enqueue = createBuildQueue();
    const first = deferred();
    const older = vi.fn(async () => {});
    const newer = vi.fn(async () => {});

    const blocker = vi.fn(() => first.promise);

    const running = enqueue(blocker);
    await vi.waitFor(() => expect(blocker).toHaveBeenCalledOnce());
    const merged = [enqueue(older), enqueue(newer)];
    first.resolve();
    await Promise.all([running, ...merged]);

    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledOnce();
  });

  it('starts another build for a request made after the follow-up build began', async () => {
    const enqueue = createBuildQueue();
    const second = deferred();
    const build = vi.fn(async () => {
      if (build.mock.calls.length === 2) await second.promise;
    });

    await enqueue(build);
    const followUp = enqueue(build);
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    const later = enqueue(build);
    second.resolve();
    await Promise.all([followUp, later]);

    expect(build).toHaveBeenCalledTimes(3);
  });

  it('resolves only after a build that started after the request', async () => {
    const enqueue = createBuildQueue();
    const first = deferred();
    const finished: number[] = [];
    let builds = 0;
    const build = async () => {
      const id = ++builds;
      if (id === 1) await first.promise;
      finished.push(id);
    };

    const running = enqueue(build);
    await vi.waitFor(() => expect(builds).toBe(1));
    const waiting = enqueue(build).then(() => [...finished]);
    first.resolve();
    await running;

    expect(await waiting).toEqual([1, 2]);
  });

  it('keeps building after a build fails', async () => {
    const enqueue = createBuildQueue();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('build failed');
    const build = vi.fn(async () => {});

    await enqueue(async () => {
      throw failure;
    });
    await enqueue(build);

    expect(error).toHaveBeenCalledWith(failure);
    expect(build).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
