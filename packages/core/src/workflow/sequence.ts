import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import {
  aliasSerializationClass,
  registerSerializationClass,
} from '../class-serialization.js';
import {
  isSequenceRef,
  SEQUENCE_CLASS_ID,
  type SequenceRef,
} from '../sequence-ref.js';

const WORKFLOW_CONTEXT = Symbol.for('WORKFLOW_CONTEXT');
function currentRunId(): string | undefined {
  return (
    (globalThis as Record<symbol, unknown>)[WORKFLOW_CONTEXT] as
      | { workflowRunId?: string }
      | undefined
  )?.workflowRunId;
}

/** Workflow-side Sequence handle. Content operations remain step-only. */
export class Sequence<T> {
  static readonly classId = SEQUENCE_CLASS_ID;
  readonly #ref: SequenceRef;

  private constructor(ref: SequenceRef) {
    this.#ref = ref;
  }

  get length(): number {
    return this.#ref.length;
  }

  take(length: number): Sequence<T> {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.length) {
      throw new RangeError('Sequence take is out of range');
    }
    if (length === this.length) return this;
    return new Sequence({ ...this.#ref, length });
  }

  static from(): never {
    throw new Error('Sequence.from() is only supported inside a step');
  }

  append(): never {
    throw new Error('Sequence.append() is only supported inside a step');
  }

  get(): never {
    throw new Error('Sequence content can only be read inside a step');
  }

  toArray(): never {
    throw new Error('Sequence content can only be read inside a step');
  }

  static [WORKFLOW_SERIALIZE](sequence: Sequence<unknown>): SequenceRef {
    const runId = currentRunId();
    if (runId && runId !== sequence.#ref.runId) {
      throw new Error('Cross-run Sequence refs are unsupported');
    }
    return sequence.#ref;
  }

  static [WORKFLOW_DESERIALIZE](ref: SequenceRef): Sequence<unknown> {
    if (!isSequenceRef(ref)) throw new Error('Malformed Sequence ref');
    const runId = currentRunId();
    if (runId && runId !== ref.runId) {
      throw new Error('Cross-run Sequence refs are unsupported');
    }
    return new Sequence({ ...ref });
  }
}

try {
  registerSerializationClass(SEQUENCE_CLASS_ID, Sequence);
} catch {
  aliasSerializationClass(SEQUENCE_CLASS_ID, Sequence);
}
