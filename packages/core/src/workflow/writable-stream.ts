import type { WorkflowWritableStreamOptions } from '../step/writable-stream.js';
import {
  STREAM_FRAMING_SYMBOL,
  STREAM_NAME_SYMBOL,
  WORKFLOW_DEFAULT_STREAM_FRAMING,
  WORKFLOW_GET_STREAM_ID,
} from '../symbols.js';

export function getWritable<W = any>(
  options: WorkflowWritableStreamOptions = {}
): WritableStream<W> {
  const { namespace } = options;
  const name = (globalThis as any)[WORKFLOW_GET_STREAM_ID](namespace);
  const descriptors: PropertyDescriptorMap = {
    [STREAM_NAME_SYMBOL]: {
      value: name,
      writable: false,
    },
  };
  // Tag the handle with the run's stream framing (computed host-side and
  // exposed as a VM global). Framing is per-stream and every writer must
  // match the run's readers: a step or external client reviving this handle
  // reads the tag from the serialized descriptor and, for framed-v2, stamps
  // frames with its own writer marker. Without the tag, a revived writer
  // would fall back to framed-v1 while `Run.getReadable` (which derives the
  // framing from the run's SDK version) strips a marker that isn't there —
  // corrupting every frame.
  const framing = (globalThis as any)[WORKFLOW_DEFAULT_STREAM_FRAMING];
  if (framing === 'framed-v2') {
    descriptors[STREAM_FRAMING_SYMBOL] = {
      value: 'framed-v2',
      writable: false,
    };
  }
  return Object.create(globalThis.WritableStream.prototype, descriptors);
}
