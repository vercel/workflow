import {
  getExternalReducers,
  getSerializeStream,
  WorkflowServerWritableStream,
} from '../serialization.js';
import { getWorkflowRunStreamId } from '../util.js';
import type { WorkflowWritableStreamOptions } from '../writable-stream.js';
import { contextStorage } from './context-storage.js';

export type { WorkflowWritableStreamOptions };

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
    getExternalReducers(globalThis, ctx.ops, runId)
  );

  // Pipe the serialized data to the workflow server stream
  // Register this async operation with the runtime's ops array so it's awaited via waitUntil
  ctx.ops.push(
    serialize.readable.pipeTo(new WorkflowServerWritableStream(name, runId))
  );

  // Return the writable side of the transform stream
  return serialize.writable;
}
