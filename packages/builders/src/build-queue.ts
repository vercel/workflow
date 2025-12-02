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
export function createBuildQueue() {
  let queue = Promise.resolve();

  return (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch((err) => {
      console.error(err);
    });
    return queue;
  };
}
