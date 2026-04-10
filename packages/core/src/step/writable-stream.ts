import {
  createFlushableState,
  flushablePipe,
  pollWritableLock,
} from '../flushable-stream.js';
import {
  getExternalReducers,
  getSerializeStream,
  WorkflowServerWritableStream,
} from '../serialization.js';
import { getWorkflowRunStreamId } from '../util.js';
import { contextStorage } from './context-storage.js';

/**
 * The options for {@link getWritable}.
 */
export interface WorkflowWritableStreamOptions {
  /**
   * An optional namespace to distinguish between multiple streams associated
   * with the same workflow run.
   */
  namespace?: string;
}

/**
 * Retrieves a writable stream that is associated with the current workflow.
 *
 * The writable stream is intended to be used within step functions to write
 * data that can be read outside the workflow by using the readable method of getRun.
 *
 * @param options - Optional configuration for the writable stream
 * @returns The writable stream associated with the current workflow run
 * @throws Error if called outside a workflow or step function
 */
export function getWritable<W = any>(
  options: WorkflowWritableStreamOptions = {}
): WritableStream<W> {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throw new Error(
      '`getWritable()` can only be called inside a workflow or step function'
    );
  }

  const { namespace } = options;
  const runId = ctx.workflowMetadata.workflowRunId;
  const name = getWorkflowRunStreamId(runId, namespace);

  // Create a transform stream that serializes chunks and pipes to the workflow server
  const serialize = getSerializeStream(
    getExternalReducers(globalThis, ctx.ops, runId, ctx.encryptionKey),
    ctx.encryptionKey
  );

  // Use flushable pipe so the ops promise resolves when the user releases
  // their writer lock, not only when the stream is explicitly closed.
  // Without this, Vercel functions hang until the runtime timeout because
  // .pipeTo() only resolves on stream close.
  const serverWritable = new WorkflowServerWritableStream(runId, name);
  const state = createFlushableState();
  ctx.ops.push(state.promise);

  flushablePipe(serialize.readable, serverWritable, state).catch(() => {
    // Errors are handled via state.reject
  });

  pollWritableLock(serialize.writable, state);

  // Return the writable side of the transform stream
  return serialize.writable;
}
