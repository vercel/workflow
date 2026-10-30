export function createBuildQueue() {
  let queue = Promise.resolve();
  let waiting: Promise<void> | undefined;
  let latestTask: () => Promise<void>;

  return (task: () => Promise<void>): Promise<void> => {
    latestTask = task;
    if (!waiting) {
      waiting = queue
        .then(() => {
          waiting = undefined;
          return latestTask();
        })
        .catch((err) => {
          console.error(err);
        });
      queue = waiting;
    }
    return waiting;
  };
}
