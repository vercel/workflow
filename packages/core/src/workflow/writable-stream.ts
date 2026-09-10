import type {
  WorkflowWritableStream,
  WorkflowWritableStreamOptions,
} from '../step/writable-stream.js';
import { STREAM_NAME_SYMBOL, WORKFLOW_GET_STREAM_ID } from '../symbols.js';

export type {
  WorkflowWritableStream,
  WorkflowWritableStreamOptions,
} from '../step/writable-stream.js';

export function getWritable<W = any>(
  options: WorkflowWritableStreamOptions = {}
): WorkflowWritableStream<W> {
  const { namespace } = options;
  const name = (globalThis as any)[WORKFLOW_GET_STREAM_ID](namespace);
  const stream = Object.create(globalThis.WritableStream.prototype, {
    [STREAM_NAME_SYMBOL]: {
      value: name,
      writable: false,
    },
  });
  return Object.assign(stream, {
    flush: async (): Promise<void> => {
      throw new Error(
        'WorkflowWritableStream.flush() can only be called inside a step function'
      );
    },
  });
}
