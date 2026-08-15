import type {
  KeyedStreamAppendRequest,
  KeyedStreamAppendResult,
} from '@workflow/world';
import { WorkflowRuntimeError } from '@workflow/errors';
import { getWorldLazy } from './runtime/get-world-lazy.js';

export class KeyedStreamAppendUnavailableError extends WorkflowRuntimeError {
  constructor() {
    super('Keyed stream append v1 is unavailable for this Workflow World');
    this.name = 'KeyedStreamAppendUnavailableError';
  }
}

/**
 * Performs one canonical keyed append. This bypasses WorkflowServerWritableStream
 * because a keyed receipt must not acknowledge a local batching buffer.
 */
export async function appendKeyedStreamChunk(
  runId: string,
  name: string,
  request: KeyedStreamAppendRequest
): Promise<KeyedStreamAppendResult> {
  const world = await getWorldLazy();
  if (
    world.keyedStreamAppendVersion !== 1 ||
    typeof world.streams.appendKeyed !== 'function'
  ) {
    throw new KeyedStreamAppendUnavailableError();
  }
  return world.streams.appendKeyed(runId, name, request);
}
