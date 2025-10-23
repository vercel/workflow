import { STREAM_NAME_SYMBOL, WORKFLOW_GET_STREAM_ID } from '../symbols.js';
import type { WorkflowWritableStreamOptions } from '../writable-stream.js';

export function getWritable<W = any>(
  options: WorkflowWritableStreamOptions = {}
): WritableStream<W> {
  const { namespace } = options;
  const name = (globalThis as any)[WORKFLOW_GET_STREAM_ID](namespace);
  return Object.create(globalThis.WritableStream.prototype, {
    [STREAM_NAME_SYMBOL]: {
      value: name,
      writable: false,
    },
  });
}
