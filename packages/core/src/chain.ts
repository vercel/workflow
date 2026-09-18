import { types } from 'node:util';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import {
  CHAIN_CLASS_ID,
  type ChainRecipe,
  type ChainRef,
  isChainRef,
} from './chain-ref.js';
import { registerSerializationClass } from './class-serialization.js';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import { contextStorage } from './step/context-storage.js';

export {
  CHAIN_CLASS_ID,
  type ChainRecipe,
  type ChainRef,
} from './chain-ref.js';

const WORKFLOW_CONTEXT = Symbol.for('WORKFLOW_CONTEXT');
type Draft = Omit<ChainRecipe, 'slot' | 'length'>;

function workflowRunId(): string | undefined {
  return (
    (globalThis as Record<symbol, unknown>)[WORKFLOW_CONTEXT] as
      | { workflowRunId?: string }
      | undefined
  )?.workflowRunId;
}
function capture(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Chain supports finite numbers');
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value))
    throw new TypeError('Chain supports acyclic JSON plain data');
  if (types.isProxy(value))
    throw new TypeError('Chain does not support proxies');
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length))
        throw new TypeError('Chain array length is invalid');
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
          throw new TypeError('Chain does not support sparse arrays');
        result.push(capture(descriptor.value, seen));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Chain supports plain objects and arrays');
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string')
        throw new TypeError('Chain does not support symbol keys');
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor))
        throw new TypeError('Chain supports enumerable data properties only');
      Object.defineProperty(result, key, {
        value: capture(descriptor.value, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Additions live only in the versioned recipe envelope of a committed step output. */
export class Chain<T> {
  readonly #ref?: ChainRef;
  readonly #draft?: Draft;
  private constructor(ref?: ChainRef, draft?: Draft) {
    this.#ref = ref;
    this.#draft = draft;
  }
  static from<T>(values: Iterable<T>): Chain<T> {
    if (workflowRunId())
      throw new Error('Chain.from() is only supported in a step');
    return new Chain(undefined, {
      take: 0,
      additions: Array.from(values, (v) => capture(v)),
    });
  }
  get length(): number {
    return (
      this.#ref?.length ??
      (this.#draft ? this.#draft.take + this.#draft.additions.length : 0)
    );
  }
  append(...values: T[]): Chain<T> {
    if (workflowRunId())
      throw new Error('Chain.append() is only supported in a step');
    if (values.length === 0) return this;
    const captured = values.map((v) => capture(v));
    if (this.#draft) {
      return new Chain(undefined, {
        base: this.#draft.base,
        take: this.#draft.take,
        // Previously captured additions are reused as inert private values;
        // no user input is inspected again.
        additions: [...this.#draft.additions, ...captured],
      });
    }
    if (!this.#ref) throw new Error('Chain has no base or draft');
    return new Chain(undefined, {
      base: this.#ref,
      take: this.length,
      additions: captured,
    });
  }
  take(length: number): Chain<T> {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.length)
      throw new RangeError('Chain take is out of range');
    if (length === this.length) return this;
    if (this.#draft) {
      if (length <= this.#draft.take) {
        if (!this.#draft.base) {
          return new Chain(undefined, { take: 0, additions: [] });
        }
        return new Chain(undefined, {
          base: { ...this.#draft.base, length },
          take: length,
          additions: [],
        });
      }
      return new Chain(undefined, {
        base: this.#draft.base,
        take: this.#draft.take,
        additions: this.#draft.additions.slice(0, length - this.#draft.take),
      });
    }
    if (!this.#ref) throw new Error('Chain has no ref or draft');
    return new Chain({ ...this.#ref, length });
  }
  async toArray(): Promise<T[]> {
    if (workflowRunId())
      throw new Error('Chain content can only be read in a step');
    if (this.#ref) return structuredClone(await resolveChain<T>(this.#ref));
    if (!this.#draft) throw new Error('Chain has no ref or draft');
    const base = this.#draft.base
      ? await resolveChain<T>(this.#draft.base)
      : [];
    return structuredClone([
      ...base.slice(0, this.#draft.take),
      ...(this.#draft.additions as T[]),
    ]);
  }
  async get(index: number): Promise<T | undefined> {
    const a = await this.toArray();
    return a[index < 0 ? a.length + index : index];
  }
  _serializeOutput(
    runId: string,
    stepId: string,
    recipes: ChainRecipe[]
  ): ChainRef {
    if (this.#ref) {
      if (this.#ref.runId !== runId)
        throw new Error('Cross-run Chain refs are unsupported');
      return this.#ref;
    }
    if (!this.#draft) throw new Error('Chain has no recipe');
    if (
      this.#draft.base?.runId !== undefined &&
      this.#draft.base.runId !== runId
    )
      throw new Error('Cross-run Chain refs are unsupported');
    const slot = `hslot_${recipes.length}`;
    const length = this.#draft.take + this.#draft.additions.length;
    recipes.push({ slot, length, ...this.#draft });
    return { runId, stepId, slot, length };
  }
  static [WORKFLOW_SERIALIZE](h: Chain<unknown>): ChainRef {
    if (!h.#ref) throw new Error('Chain additions must be returned by a step');
    const run = workflowRunId();
    if (run && run !== h.#ref.runId)
      throw new Error('Cross-run Chain refs are unsupported');
    return h.#ref;
  }
  static [WORKFLOW_DESERIALIZE](ref: ChainRef): Chain<unknown> {
    if (!isChainRef(ref)) throw new Error('Malformed Chain ref');
    const run = workflowRunId();
    if (run && run !== ref.runId)
      throw new Error('Cross-run Chain refs are unsupported');
    return new Chain({ ...ref });
  }
}

function validateRecipe(r: ChainRecipe, ref: ChainRef): void {
  if (
    !r ||
    r.slot !== ref.slot ||
    !Number.isSafeInteger(r.length) ||
    r.length < 0 ||
    !Number.isSafeInteger(r.take) ||
    r.take < 0 ||
    !Array.isArray(r.additions) ||
    r.length !== r.take + r.additions.length ||
    (r.base !== undefined && (!isChainRef(r.base) || r.take > r.base.length))
  )
    throw new Error(`Malformed Chain recipe ${ref.stepId}/${ref.slot}`);
}
async function loadRecipe(ref: ChainRef): Promise<ChainRecipe> {
  const cache = contextStorage.getStore()?.replayPayloadCache;
  let prepared = await cache?.prepareCommittedStepOutput(ref.runId, ref.stepId);
  if (!prepared) {
    const step = await (await getWorldLazy()).steps.get(ref.runId, ref.stepId, {
      resolveData: 'all',
    });
    if (step.status !== 'completed' || !(step.output instanceof Uint8Array))
      throw new Error(`Chain producing step missing: ${ref.stepId}`);
    const { prepareReplayPayload } = await import('./serialization.js');
    prepared = await prepareReplayPayload(
      step.output,
      contextStorage.getStore()?.encryptionKey
    );
  }
  const recipes = prepared.parseChainRecipes?.();
  if (!recipes)
    throw new Error(`Chain slot missing: ${ref.stepId}/${ref.slot}`);
  const matches = recipes.filter((recipe) => recipe.slot === ref.slot);
  if (matches.length !== 1)
    throw new Error(
      `Chain duplicate or missing slot: ${ref.stepId}/${ref.slot}`
    );
  validateRecipe(matches[0], ref);
  return matches[0];
}

async function resolveChain<T>(root: ChainRef): Promise<T[]> {
  const activeRunId = contextStorage.getStore()?.workflowMetadata.workflowRunId;
  if (activeRunId && activeRunId !== root.runId)
    throw new Error('Cross-run Chain refs are unsupported');
  const stack = new Set<string>();
  const chunks: Array<{ values: T[]; take: number }> = [];
  let current: ChainRef | undefined = root;
  let required = root.length;
  while (current && required > 0) {
    if (required > current.length)
      throw new Error(
        `Chain requested prefix exceeds reference: ${current.stepId}/${current.slot}`
      );
    if (current.runId !== root.runId)
      throw new Error('Cross-run Chain ancestry is unsupported');
    const key = `${current.stepId}/${current.slot}`;
    if (stack.has(key)) throw new Error(`Chain cycle at ${key}`);
    if (stack.size >= 10_000) throw new Error('Chain ancestry is too deep');
    stack.add(key);
    const recipe = await loadRecipe(current);
    if (required > recipe.length)
      throw new Error(`Chain ref length exceeds recipe: ${key}`);
    const baseNeeded = Math.min(required, recipe.take);
    const additionsNeeded = Math.max(0, required - recipe.take);
    if (additionsNeeded > recipe.additions.length)
      throw new Error(`Chain additions range is malformed: ${key}`);
    if (additionsNeeded > 0)
      chunks.push({ values: recipe.additions as T[], take: additionsNeeded });
    if (baseNeeded > 0 && !recipe.base)
      throw new Error(`Chain base is missing: ${key}`);
    current = recipe.base;
    required = baseNeeded;
  }
  const result = new Array<T>(root.length);
  let offset = 0;
  for (let index = chunks.length - 1; index >= 0; index--) {
    const chunk = chunks[index];
    for (let item = 0; item < chunk.take; item++)
      result[offset++] = chunk.values[item];
  }
  if (offset !== root.length) throw new Error('Chain resolved length mismatch');
  return result;
}
registerSerializationClass(CHAIN_CLASS_ID, Chain);
