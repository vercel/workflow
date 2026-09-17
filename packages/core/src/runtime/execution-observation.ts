import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';

type ExecutionMode = 'replay' | 'retained';
const observations = channel('workflow.execution');

/** Observe VM passes without exposing workflow inputs, results, or errors. */
export async function observeWorkflowPass<T>(
  context: {
    runId: string;
    loopIteration: number;
    mode: ExecutionMode;
    parentSpanId?: string;
    ownerId?: string;
  },
  execute: (setMode: (mode: ExecutionMode) => void) => Promise<T>
): Promise<T> {
  if (!observations.hasSubscribers) return execute(() => {});
  const passId = randomUUID();
  const startedAt = Date.now();
  let mode = context.mode;
  let status: 'completed' | 'error' = 'error';
  const publish = (event: 'begin' | 'end') =>
    observations.publish({
      version: 1,
      event,
      runId: context.runId,
      passId,
      loopIteration: context.loopIteration,
      parentSpanId: context.parentSpanId,
      ownerId: context.ownerId,
      engine: 'node',
      mode,
      at: Date.now(),
      ...(event === 'end' ? { status, elapsedMs: Date.now() - startedAt } : {}),
    });
  publish('begin');
  try {
    const result = await execute((nextMode) => {
      mode = nextMode;
    });
    status = 'completed';
    return result;
  } finally {
    publish('end');
  }
}
