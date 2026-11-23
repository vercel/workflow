import {
  createFlushableState,
  flushablePipe,
  pollWritableLock,
  trackFlushableWritable,
} from '../flushable-stream.js';
import {
  getExternalReducers,
  getSerializeStream,
  WorkflowServerWritableStream,
} from '../serialization.js';
import {
  STREAM_NAME_SYMBOL,
  STREAM_SERVER_DEPLOYMENT_ID_SYMBOL,
  STREAM_SERVER_RUN_ID_SYMBOL,
} from '../symbols.js';
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

  // Create a transform stream that serializes chunks and pipes to the workflow server.
  // The target run is the workflow run that owns this step, which (per
  // version skew protection) is on this same SDK version, so byte-stream
  // framing is always safe here.
  const serialize = getSerializeStream(
    getExternalReducers(globalThis, ctx.ops, runId, ctx.encryptionKey, true),
    ctx.encryptionKey
  );

  // Use flushable pipe so the ops promise resolves when the user releases
  // their writer lock, not only when the stream is explicitly closed.
  // Without this, Vercel functions hang until the runtime timeout because
  // .pipeTo() only resolves on stream close.
  const serverWritable = new WorkflowServerWritableStream(name, runId);
  const state = createFlushableState();
  // The step handler waits for the step's writes to reach the server before
  // it completes the step.
  ctx.streamStates?.push(state);
  ctx.ops.push(state.promise);

  flushablePipe(serialize.readable, serverWritable, state).catch(() => {
    // Errors are handled via state.reject
  });

  const writable = trackFlushableWritable(serialize.writable, state);
  pollWritableLock(writable, state);

  // Tag the writable with its underlying `(runId, name)` so downstream
  // reducers can recognize that it's already backed by a workflow
  // server stream. Calling `start(child, [args, theWritable])` from
  // the same step uses these tags to emit `{ name, runId }` in the
  // dehydrated descriptor, so the child's reviver can open the
  // writable against the original `(runId, name)` directly — no
  // in-process bridge tied to this step's lifetime.
  Object.defineProperty(writable, STREAM_NAME_SYMBOL, {
    value: name,
    writable: false,
  });
  Object.defineProperty(writable, STREAM_SERVER_RUN_ID_SYMBOL, {
    value: runId,
    writable: false,
  });
  if (ctx.workflowDeploymentId) {
    Object.defineProperty(writable, STREAM_SERVER_DEPLOYMENT_ID_SYMBOL, {
      value: ctx.workflowDeploymentId,
      writable: false,
    });
  }

  // Return the user-facing side of the serialization pipe
  return writable as WritableStream<W>;
}
