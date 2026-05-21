import { throwNotInWorkflowOrStepContext } from '../context-errors.js';
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
import { STREAM_NAME_SYMBOL, STREAM_SERVER_RUN_ID_SYMBOL } from '../symbols.js';
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
    throwNotInWorkflowOrStepContext(
      'getWritable()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/get-writable',
      getWritable
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

  // Tag the writable with its underlying `(runId, name)` so downstream
  // reducers can recognize that it's already backed by a workflow
  // server stream. Calling `start(child, [args, theWritable])` from
  // the same step uses these tags to emit `{ name, runId }` in the
  // dehydrated descriptor, so the child's reviver can open the
  // writable against the original `(runId, name)` directly — no
  // in-process bridge tied to this step's lifetime.
  Object.defineProperty(serialize.writable, STREAM_NAME_SYMBOL, {
    value: name,
    writable: false,
  });
  Object.defineProperty(serialize.writable, STREAM_SERVER_RUN_ID_SYMBOL, {
    value: runId,
    writable: false,
  });

  // Return the writable side of the transform stream
  return serialize.writable;
}
