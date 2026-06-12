import {
  deadLetterSink,
  fixDemoBug,
  type QueueItem,
  redriveDeadLetters,
} from '../patterns/dead-letter-queue.js';

// Module state (the in-memory DLQ sink) lives in the step bundle — tests
// can only observe it through a step's return value.
async function readSink(): Promise<
  Array<{ item: QueueItem; error: string; failedAt: string }>
> {
  'use step';
  return deadLetterSink.map((entry) => ({ ...entry }));
}

/** Snapshot the dead letter sink. */
export async function readDeadLetterSink() {
  'use workflow';
  return await readSink();
}

/** Simulate deploying a fix, then redrive up to `limit` dead letters. */
export async function fixBugAndRedrive(limit: number) {
  'use workflow';
  await fixDemoBug();
  return await redriveDeadLetters(limit);
}
