/**
 * The World's operator notices: lines meant for whoever runs the process
 * (a process that only enqueues, a namespace mismatch, a runner that failed
 * to start), not diagnostics. They go to the console unconditionally, since
 * a broken deployment must never be silent, except in the CLI's JSON mode
 * (`WORKFLOW_JSON_MODE=1`), whose output must stay machine-readable; the
 * queue's Graphile logger is silent there too. A line without a prefix of
 * its own gets `[postgres world]`.
 */
export const operatorLog = {
  warn(message: string, ...rest: unknown[]): void {
    if (isJsonMode()) return;
    console.warn(prefixed(message), ...rest);
  },
  error(message: string, ...rest: unknown[]): void {
    if (isJsonMode()) return;
    console.error(prefixed(message), ...rest);
  },
};

/** Whether the process is the CLI in JSON mode, whose stdout is data. */
export function isJsonMode(): boolean {
  return process.env.WORKFLOW_JSON_MODE === '1';
}

/** Adds the prefix unless the line already carries one of the package's. */
function prefixed(message: string): string {
  return message.startsWith('[') ? message : `[postgres world] ${message}`;
}
