import { channel } from 'node:diagnostics_channel';

const observations = channel('workflow.invocation');

/** Observe actual operation boundaries without putting subscriber work before them. */
export async function observeInvocation<T>(
  phase: 'lookup' | 'http',
  identity: { runId: string; requestId: string; invocationId: string },
  operation: () => Promise<T>
): Promise<T> {
  if (!observations.hasSubscribers) return operation();
  const started = performance.now();
  const at = Date.now();
  try {
    let work: Promise<T>;
    try {
      work = operation();
    } finally {
      observations.publish({
        version: 1,
        ...identity,
        phase,
        event: 'begin',
        at,
      });
    }
    const value = await work;
    observations.publish({
      version: 1,
      ...identity,
      phase,
      event: 'end',
      at: Date.now(),
      elapsedMs: performance.now() - started,
      status: 'completed',
    });
    return value;
  } catch (error) {
    observations.publish({
      version: 1,
      ...identity,
      phase,
      event: 'end',
      at: Date.now(),
      elapsedMs: performance.now() - started,
      status: 'error',
    });
    throw error;
  }
}
