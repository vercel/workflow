export interface BuildQueueOptions {
  /**
   * Preserve the historical watcher behavior of logging a failed build and
   * keeping the queue alive. Set to `false` for startup/production builds
   * where a failed derived-artifact hook must reject the build.
   */
  swallowErrors?: boolean;
}

/**
 * Creates a build queue that serializes async tasks to prevent race conditions.
 *
 * When rapid file changes trigger multiple builds, this ensures they run
 * sequentially rather than concurrently, avoiding issues like:
 * - Partial file reads during writes
 * - Corrupted merge operations
 * - Duplicate/conflicting builds
 *
 * @example
 * const enqueue = createBuildQueue();
 *
 * // These will run sequentially, not concurrently
 * enqueue(() => builder.build());
 * enqueue(() => builder.build());
 */
export function createBuildQueue({
  swallowErrors = true,
}: BuildQueueOptions = {}) {
  let queue = Promise.resolve();

  return (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch((err) => {
      if (!swallowErrors) {
        throw err;
      }
      console.error(err);
    });
    return queue;
  };
}
