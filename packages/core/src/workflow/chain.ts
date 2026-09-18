import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import { CHAIN_CLASS_ID, type ChainRef, isChainRef } from '../chain-ref.js';

const WORKFLOW_CONTEXT = Symbol.for('WORKFLOW_CONTEXT');
function currentRunId(): string | undefined {
  return (
    (globalThis as Record<symbol, unknown>)[WORKFLOW_CONTEXT] as
      | { workflowRunId?: string }
      | undefined
  )?.workflowRunId;
}

/** Workflow-side Chain handle. Content operations remain step-only. */
export class Chain<T> {
  static readonly classId = CHAIN_CLASS_ID;
  readonly #ref: ChainRef;

  private constructor(ref: ChainRef) {
    this.#ref = ref;
  }

  get length(): number {
    return this.#ref.length;
  }

  take(length: number): Chain<T> {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.length) {
      throw new RangeError('Chain take is out of range');
    }
    if (length === this.length) return this;
    return new Chain({ ...this.#ref, length });
  }

  static from(): never {
    throw new Error('Chain.from() is only supported inside a step');
  }

  append(): never {
    throw new Error('Chain.append() is only supported inside a step');
  }

  get(): never {
    throw new Error('Chain content can only be read inside a step');
  }

  toArray(): never {
    throw new Error('Chain content can only be read inside a step');
  }

  static [WORKFLOW_SERIALIZE](sequence: Chain<unknown>): ChainRef {
    const runId = currentRunId();
    if (runId && runId !== sequence.#ref.runId) {
      throw new Error('Cross-run Chain refs are unsupported');
    }
    return sequence.#ref;
  }

  static [WORKFLOW_DESERIALIZE](ref: ChainRef): Chain<unknown> {
    if (!isChainRef(ref)) throw new Error('Malformed Chain ref');
    const runId = currentRunId();
    if (runId && runId !== ref.runId) {
      throw new Error('Cross-run Chain refs are unsupported');
    }
    return new Chain({ ...ref });
  }
}
