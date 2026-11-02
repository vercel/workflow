/**
 * Experimental replay-derived delta encoding for step inputs.
 *
 * Opt-in with `WORKFLOW_INPUT_DELTA=1`. When a new step is called with
 * arguments that are plain JSON-like data, and an earlier call of the same
 * step (whose input is already committed) is available from replay, the
 * persisted input is an `InputDelta` envelope: a structural patch against that
 * earlier call's arguments plus a SHA-256 digest of the full logical value.
 *
 * - The base comes from replay: workflow code re-derives the previous call's
 *   arguments while replaying, so no historical input is fetched to compute
 *   the patch.
 * - The inline step is hydrated from the full payload kept in process memory
 *   (keyed by digest), not reconstructed from the patch.
 * - Cold recovery (a step executed without that memory) walks the base chain
 *   through `world.steps.get`, applies patches in order and verifies every
 *   link's digest. Every `WORKFLOW_INPUT_DELTA_SNAPSHOT_EVERY`th call of a step
 *   name (default 16) is stored as an ordinary full input, bounding the chain.
 *
 * Unsupported values (anything other than plain objects, arrays and
 * primitives, in either the base or the new value) are stored as ordinary full
 * inputs. Persisted envelopes stay readable when the writer flag is off.
 */
import { globalSingleton } from '@workflow/utils';

export const INPUT_DELTA_REDUCER = 'InputDeltaV1';

export type ValueOp =
  | { k: 'v'; v: unknown }
  /** String that extends its base: keep the first `n` chars, append `v`. */
  | { k: 's'; n: number; v: string }
  | { k: 'a'; n: number; s?: [number, unknown][]; p?: [number, ValueOp][] }
  | {
      k: 'o';
      keys?: string[];
      s?: [string, unknown][];
      p?: [string, ValueOp][];
    };

export interface InputDeltaData {
  v: 1;
  /** Correlation ID (step ID) of the base call, in the same run. */
  base: string;
  /** Position in the delta chain since the last full snapshot (1-based). */
  depth: number;
  /** SHA-256 (hex) of the full value's devalue payload. */
  digest: string;
  op: ValueOp;
}

/** Host-realm marker so devalue can reduce/revive the envelope unambiguously. */
export class InputDelta {
  constructor(readonly data: InputDeltaData) {}
}

export function isInputDelta(value: unknown): value is InputDelta {
  return value instanceof InputDelta;
}

export function inputDeltaEnabled(): boolean {
  return process.env.WORKFLOW_INPUT_DELTA === '1';
}

export function inputDeltaSnapshotEvery(): number {
  const n = Number(process.env.WORKFLOW_INPUT_DELTA_SNAPSHOT_EVERY ?? 16);
  return Number.isInteger(n) && n >= 1 ? n : 16;
}

/** Cross-realm plain-data check (workflow values come from the VM realm). */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  return (
    Object.getPrototypeOf(proto) === null &&
    typeof proto.constructor === 'function' &&
    proto.constructor.name === 'Object'
  );
}

function isPlainArray(value: unknown[]): boolean {
  const proto = Object.getPrototypeOf(value);
  return (
    proto !== null &&
    typeof proto.constructor === 'function' &&
    proto.constructor.name === 'Array' &&
    Array.isArray(value)
  );
}

/**
 * Whether `value` is entirely plain data the patcher supports. Shared subtrees
 * are visited once (memo), so structurally shared histories stay cheap.
 */
export function isPlainData(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): boolean {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'undefined':
    case 'bigint':
      return true;
    case 'object': {
      if (value === null) return true;
      if (seen.has(value)) return true;
      seen.add(value);
      if (Array.isArray(value)) {
        if (!isPlainArray(value)) return false;
        // Holes and extra own properties change devalue output.
        const keys = Object.keys(value);
        if (keys.length !== value.length) return false;
        for (let i = 0; i < value.length; i++) {
          if (!isPlainData(value[i], seen)) return false;
        }
        return true;
      }
      if (!isPlainObject(value)) return false;
      if (Object.getOwnPropertySymbols(value).length > 0) return false;
      for (const key of Object.keys(value)) {
        if (!isPlainData((value as Record<string, unknown>)[key], seen))
          return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/** Whether `value` is a container the patcher descends into. */
function isPlainContainer(value: object): boolean {
  if (Array.isArray(value)) {
    return isPlainArray(value) && Object.keys(value).length === value.length;
  }
  return (
    isPlainObject(value) && Object.getOwnPropertySymbols(value).length === 0
  );
}

/**
 * Structural patch from `base` to `next`.
 *
 * Plain arrays and objects are descended into; every other non-primitive
 * (streams, abort signals, Dates, class instances...) is an opaque leaf that
 * is always re-emitted, even when it is the same object, because its
 * serialized form can change without its identity changing (an AbortSignal
 * becoming aborted). The identity shortcut is only taken for subtrees that are
 * entirely plain data (memoized in `plain`), which is what Eve's copy-on-write
 * history sharing produces. Returns undefined when nothing changed.
 */
export function diffValue(
  base: unknown,
  next: unknown,
  plain: WeakSet<object> = new WeakSet()
): ValueOp | undefined {
  const nextObject = next !== null && typeof next === 'object';
  if (!nextObject) {
    if (Object.is(base, next)) return undefined;
    if (
      typeof base === 'string' &&
      typeof next === 'string' &&
      base.length >= 256 &&
      next.length > base.length &&
      next.startsWith(base)
    ) {
      return { k: 's', n: base.length, v: next.slice(base.length) };
    }
    return { k: 'v', v: next };
  }
  if (!isPlainContainer(next as object)) return { k: 'v', v: next };
  if (Object.is(base, next) && isPlainData(next, plain)) return undefined;
  if (
    base === null ||
    typeof base !== 'object' ||
    !isPlainContainer(base as object) ||
    Array.isArray(base) !== Array.isArray(next)
  ) {
    return { k: 'v', v: next };
  }
  if (Array.isArray(next)) {
    const b = base as unknown[];
    const n = next as unknown[];
    const s: [number, unknown][] = [];
    const p: [number, ValueOp][] = [];
    for (let i = 0; i < n.length; i++) {
      if (i >= b.length) {
        s.push([i, n[i]]);
        continue;
      }
      const change = diffValue(b[i], n[i], plain);
      if (change === undefined) continue;
      if (change.k === 'v') s.push([i, change.v]);
      else p.push([i, change]);
    }
    if (n.length === b.length && s.length === 0 && p.length === 0)
      return undefined;
    const op: ValueOp = { k: 'a', n: n.length };
    if (s.length) op.s = s;
    if (p.length) op.p = p;
    return op;
  }
  const b = base as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const baseKeys = Object.keys(b);
  const nextKeys = Object.keys(n);
  const s: [string, unknown][] = [];
  const p: [string, ValueOp][] = [];
  for (const key of nextKeys) {
    if (!Object.hasOwn(b, key)) {
      s.push([key, n[key]]);
      continue;
    }
    const change = diffValue(b[key], n[key], plain);
    if (change === undefined) continue;
    if (change.k === 'v') s.push([key, change.v]);
    else p.push([key, change]);
  }
  // Key order affects the serialized payload (and therefore its digest), so
  // record it whenever it is not exactly the base order.
  const sameKeys =
    baseKeys.length === nextKeys.length &&
    baseKeys.every((key, i) => key === nextKeys[i]);
  if (sameKeys && s.length === 0 && p.length === 0) return undefined;
  const op: ValueOp = { k: 'o' };
  if (!sameKeys) op.keys = nextKeys;
  if (s.length) op.s = s;
  if (p.length) op.p = p;
  return op;
}

/**
 * A custom-serialized value (stream, signal, step function...) decoded
 * without its reviver during cold recovery. It re-serializes to exactly the
 * same devalue record, so a recovered payload can be digest-checked and then
 * decoded once with the real step revivers.
 */
export class OpaqueValue {
  constructor(
    readonly type: string,
    readonly data: unknown
  ) {}
}

/**
 * Revivers/reducers pair for recovery. `customTypes` must be exactly the
 * reducer names of the codec that wrote the payload: every record of those
 * types is in devalue's custom-record form, so wrapping it as an
 * `OpaqueValue` and re-emitting it reproduces the same bytes. Types the codec
 * has no reducer for are left to devalue's built-in handling, which also
 * round-trips. The input delta envelope itself is revived for real.
 */
export function createOpaqueCodec(customTypes: Iterable<string>) {
  const types = new Set(customTypes);
  types.delete(INPUT_DELTA_REDUCER);
  const revivers: Record<string, (v: any) => unknown> = {
    [INPUT_DELTA_REDUCER]: (v: InputDeltaData) => new InputDelta(v),
  };
  const reducers: Record<string, (v: unknown) => unknown> = {};
  for (const type of types) {
    revivers[type] = (v: unknown) => new OpaqueValue(type, v);
    reducers[type] = (v: unknown) =>
      v instanceof OpaqueValue && v.type === type ? v.data : false;
  }
  return { revivers, reducers: () => reducers };
}

/** Applies `op` to `base` without mutating it. */
export function applyValueOp(base: unknown, op: ValueOp | undefined): unknown {
  if (op === undefined) return base;
  if (op.k === 'v') return op.v;
  if (op.k === 's') {
    if (typeof base !== 'string' || base.length < op.n)
      throw new Error('Input delta expects a string prefix');
    return base.slice(0, op.n) + op.v;
  }
  if (op.k === 'a') {
    if (!Array.isArray(base)) throw new Error('Input delta expects an array');
    const next = base.slice(0, op.n);
    for (const [i, change] of op.p ?? [])
      next[i] = applyValueOp(base[i], change);
    for (const [i, value] of op.s ?? []) next[i] = value;
    if (next.length !== op.n) throw new Error('Input delta length mismatch');
    return next;
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    throw new Error('Input delta expects an object');
  }
  const b = base as Record<string, unknown>;
  const set = new Map(op.s ?? []);
  const patch = new Map(op.p ?? []);
  const keys = op.keys ?? Object.keys(b);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key === '__proto__') throw new Error('Input delta: invalid key');
    if (set.has(key)) out[key] = set.get(key);
    else if (patch.has(key)) out[key] = applyValueOp(b[key], patch.get(key));
    else if (Object.hasOwn(b, key)) out[key] = b[key];
    else throw new Error(`Input delta: missing base key ${key}`);
  }
  // New keys absent from an explicit list cannot happen; implied lists keep
  // base order and append nothing, so set-only keys must be listed.
  if (!op.keys) {
    for (const key of set.keys())
      if (!Object.hasOwn(b, key)) out[key] = set.get(key);
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(hash).toString('hex');
}

/**
 * Process-local map from digest to the full devalue payload of inputs written
 * as deltas by this process. The inline step reads its arguments from here.
 */
const fullPayloads = globalSingleton(
  '__workflowInputDeltaFullPayloads',
  1,
  () => new Map<string, Uint8Array>()
);
const MAX_CACHED = 64;

export function rememberFullPayload(digest: string, payload: Uint8Array) {
  fullPayloads.delete(digest);
  fullPayloads.set(digest, payload);
  while (fullPayloads.size > MAX_CACHED) {
    const oldest = fullPayloads.keys().next().value as string;
    fullPayloads.delete(oldest);
  }
}

export function takeFullPayload(digest: string): Uint8Array | undefined {
  return fullPayloads.get(digest);
}

/** Counters surfaced on spans for the benchmark. */
export interface InputDeltaStats {
  memoryHits: number;
  recoveryFetches: number;
  patchesApplied: number;
}
