import { types } from 'node:util';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import { registerSerializationClass } from './class-serialization.js';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import { contextStorage } from './step/context-storage.js';

export const HISTORY_CLASS_ID = 'class//workflow//History';
const WORKFLOW_CONTEXT = Symbol.for('WORKFLOW_CONTEXT');
export type HistoryRef = {
  runId: string;
  stepId: string;
  slot: string;
  length: number;
};
export type HistoryRecipe = {
  slot: string;
  length: number;
  base?: HistoryRef;
  take: number;
  additions: unknown[];
};
type Draft = Omit<HistoryRecipe, 'slot' | 'length'>;

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
      throw new TypeError('History supports finite numbers');
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value))
    throw new TypeError('History supports acyclic JSON plain data');
  if (types.isProxy(value))
    throw new TypeError('History does not support proxies');
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length))
        throw new TypeError('History array length is invalid');
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
          throw new TypeError('History does not support sparse arrays');
        result.push(capture(descriptor.value, seen));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('History supports plain objects and arrays');
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string')
        throw new TypeError('History does not support symbol keys');
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor))
        throw new TypeError('History supports enumerable data properties only');
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
function validRef(v: unknown): v is HistoryRef {
  const r = v as HistoryRef;
  return (
    !!r &&
    typeof r.runId === 'string' &&
    typeof r.stepId === 'string' &&
    typeof r.slot === 'string' &&
    Number.isSafeInteger(r.length) &&
    r.length >= 0
  );
}

/** Additions live only in the versioned recipe envelope of a committed step output. */
export class History<T> {
  readonly #ref?: HistoryRef;
  readonly #draft?: Draft;
  private constructor(ref?: HistoryRef, draft?: Draft) {
    this.#ref = ref;
    this.#draft = draft;
  }
  static from<T>(values: Iterable<T>): History<T> {
    if (workflowRunId())
      throw new Error('History.from() is only supported in a step');
    return new History(undefined, {
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
  append(...values: T[]): History<T> {
    if (workflowRunId())
      throw new Error('History.append() is only supported in a step');
    if (values.length === 0) return this;
    const captured = values.map((v) => capture(v));
    if (this.#draft) {
      return new History(undefined, {
        base: this.#draft.base,
        take: this.#draft.take,
        // Previously captured additions are reused as inert private values;
        // no user input is inspected again.
        additions: [...this.#draft.additions, ...captured],
      });
    }
    if (!this.#ref) throw new Error('History has no base or draft');
    return new History(undefined, {
      base: this.#ref,
      take: this.length,
      additions: captured,
    });
  }
  take(length: number): History<T> {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.length)
      throw new RangeError('History take is out of range');
    if (length === this.length) return this;
    if (this.#draft) {
      if (length <= this.#draft.take) {
        if (!this.#draft.base) {
          return new History(undefined, { take: 0, additions: [] });
        }
        return new History(undefined, {
          base: { ...this.#draft.base, length },
          take: length,
          additions: [],
        });
      }
      return new History(undefined, {
        base: this.#draft.base,
        take: this.#draft.take,
        additions: this.#draft.additions.slice(0, length - this.#draft.take),
      });
    }
    if (!this.#ref) throw new Error('History has no ref or draft');
    return new History({ ...this.#ref, length });
  }
  async toArray(): Promise<T[]> {
    if (workflowRunId())
      throw new Error('History content can only be read in a step');
    if (this.#ref) return structuredClone(await resolveHistory<T>(this.#ref));
    if (!this.#draft) throw new Error('History has no ref or draft');
    const base = this.#draft.base
      ? await resolveHistory<T>(this.#draft.base)
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
    recipes: HistoryRecipe[]
  ): HistoryRef {
    if (this.#ref) {
      if (this.#ref.runId !== runId)
        throw new Error('Cross-run History refs are unsupported');
      return this.#ref;
    }
    if (!this.#draft) throw new Error('History has no recipe');
    const slot = `hslot_${recipes.length}`;
    const length = this.#draft.take + this.#draft.additions.length;
    recipes.push({ slot, length, ...this.#draft });
    return { runId, stepId, slot, length };
  }
  static [WORKFLOW_SERIALIZE](h: History<unknown>): HistoryRef {
    if (!h.#ref)
      throw new Error('History additions must be returned by a step');
    const run = workflowRunId();
    if (run && run !== h.#ref.runId)
      throw new Error('Cross-run History refs are unsupported');
    return h.#ref;
  }
  static [WORKFLOW_DESERIALIZE](ref: HistoryRef): History<unknown> {
    if (!validRef(ref)) throw new Error('Malformed History ref');
    const run = workflowRunId();
    if (run && run !== ref.runId)
      throw new Error('Cross-run History refs are unsupported');
    return new History({ ...ref });
  }
}

function validateRecipe(r: HistoryRecipe, ref: HistoryRef): void {
  if (
    !r ||
    r.slot !== ref.slot ||
    !Number.isSafeInteger(r.length) ||
    r.length < 0 ||
    !Number.isSafeInteger(r.take) ||
    r.take < 0 ||
    !Array.isArray(r.additions) ||
    r.length !== r.take + r.additions.length ||
    (r.base !== undefined && !validRef(r.base))
  )
    throw new Error(`Malformed History recipe ${ref.stepId}/${ref.slot}`);
}
async function loadRecipe(ref: HistoryRef): Promise<HistoryRecipe> {
  const cache = contextStorage.getStore()?.replayPayloadCache;
  let prepared = await cache?.prepareCommittedStepOutput(ref.runId, ref.stepId);
  if (!prepared) {
    const step = await (await getWorldLazy()).steps.get(ref.runId, ref.stepId, {
      resolveData: 'all',
    });
    if (step.status !== 'completed' || !(step.output instanceof Uint8Array))
      throw new Error(`History producing step missing: ${ref.stepId}`);
    const { prepareReplayPayload } = await import('./serialization.js');
    prepared = await prepareReplayPayload(
      step.output,
      contextStorage.getStore()?.encryptionKey
    );
  }
  const recipes = prepared.parseHistoryRecipes?.();
  if (!recipes)
    throw new Error(`History slot missing: ${ref.stepId}/${ref.slot}`);
  const matches = recipes.filter((recipe) => recipe.slot === ref.slot);
  if (matches.length !== 1)
    throw new Error(
      `History duplicate or missing slot: ${ref.stepId}/${ref.slot}`
    );
  validateRecipe(matches[0], ref);
  return matches[0];
}

async function resolveHistory<T>(root: HistoryRef): Promise<T[]> {
  const stack = new Set<string>();
  const chunks: Array<{ values: T[]; take: number }> = [];
  let current: HistoryRef | undefined = root;
  let required = root.length;
  while (current && required > 0) {
    if (current.runId !== root.runId)
      throw new Error('Cross-run History ancestry is unsupported');
    const key = `${current.stepId}/${current.slot}`;
    if (stack.has(key)) throw new Error(`History cycle at ${key}`);
    if (stack.size >= 10_000) throw new Error('History ancestry is too deep');
    stack.add(key);
    const recipe = await loadRecipe(current);
    if (required > recipe.length)
      throw new Error(`History ref length exceeds recipe: ${key}`);
    const baseNeeded = Math.min(required, recipe.take);
    const additionsNeeded = Math.max(0, required - recipe.take);
    if (additionsNeeded > recipe.additions.length)
      throw new Error(`History additions range is malformed: ${key}`);
    if (additionsNeeded > 0)
      chunks.push({ values: recipe.additions as T[], take: additionsNeeded });
    if (baseNeeded > 0 && !recipe.base)
      throw new Error(`History base is missing: ${key}`);
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
  if (offset !== root.length)
    throw new Error('History resolved length mismatch');
  return result;
}
registerSerializationClass(HISTORY_CLASS_ID, History);
