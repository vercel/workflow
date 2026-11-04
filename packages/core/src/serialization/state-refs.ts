import { globalSingleton } from '@workflow/utils';
import { parse } from 'devalue';
import {
  applyStateOps,
  diffState,
  isPlainObject,
  opsBytes,
  type StateOp,
} from '../state.js';

/**
 * Stores frozen values passed between steps by reference.
 *
 * A deeply frozen plain value (for example a result of immer's `produce`)
 * can't change, so Workflow can tell what it already holds by identity. It is
 * written as a reference when it is a version this invocation knows, as only
 * its change from the known version its unchanged objects belong to, and
 * whole otherwise. Long strings that already arrived in a
 * hook payload or the run input are written as references to that payload.
 * Readers rebuild values from the run's own log, so nothing refers outside it.
 *
 * Only versions a reader of the log can see are referenceable: step outputs,
 * and the hook payloads and run input registered with `addSource`. Step inputs
 * are never read back (replay and recovery skip them), so the versions a step
 * input carries are not remembered on either side.
 *
 * Hook payloads and run inputs keep their usual format. Each reader knows the
 * event a payload came from and registers its strings under that event's id
 * (see `stateSourceId`), so a runtime without this module reads them as before.
 */

export const STATE_REF_REDUCER = 'StateRefV1';
export const STATE_SOURCE_REDUCER = 'StateSrcV1';

/**
 * A value is written whole again once its changes since the last whole copy
 * pass this many bytes and half the value's size (for a growing value: each
 * time it doubles), or after {@link SNAPSHOT_MAX_RECORDS} changes. That bounds
 * how much of the log a rebuild applies to about twice the value's size, and
 * adds whole copies totalling about twice its final size.
 */
const SNAPSHOT_MIN_BYTES = 64 * 1024;
const SNAPSHOT_MAX_RECORDS = 1_000;
/** Shorter strings are not worth a reference. */
const SOURCE_STRING_MIN = 128;
const MAX_ID = 256;
const MAX_PATH = 64;
const MAX_DEPTH = 256;
/** How many recent step-input versions a new value is compared with by value. */
const MAX_RECENT_INPUTS = 4;

type Dict = Record<string, unknown>;
interface Version {
  readonly logId: string;
  readonly value: unknown;
  readonly bytesSinceFull: number;
  /** Changes since the last whole value. */
  readonly recordsSinceFull: number;
  /** The value's measured size, and `bytesSinceFull` when it was measured. */
  readonly measured?: Measured;
}
interface Measured {
  readonly bytes: number;
  readonly at: number;
}

/**
 * A record refers to a version, base or source this context has not seen: the
 * log it was rebuilt from is missing what the writer saw.
 */
export class WorkflowStateMissingError extends Error {
  override name = 'WorkflowStateMissingError';
}

/**
 * Set on a step input by a workflow that reads state records (the Node VM
 * engine). A step writes records only when its input has it: the run's
 * workflow reads the step's output, and a QuickJS workflow can't read them,
 * whatever the step process's own `WORKFLOW_VM` says.
 */
export const STATE_REFS_FIELD = 'stateRefs';

/** The id a reader registers a payload's strings under (see `addSource`). */
export function stateSourceId(
  event: { eventType: string; eventId?: string } | 'run-input'
): string | undefined {
  if (event === 'run-input') return 'run';
  return event.eventType === 'hook_received' && event.eventId
    ? `hook:${event.eventId}`
    : undefined;
}
interface SourceString {
  readonly id: string;
  readonly path: readonly (string | number)[];
}

/** A string in a state change that is stored in a hook payload or run input instead. */
export class StateSourceRef {
  constructor(
    readonly id: string,
    readonly path: readonly (string | number)[]
  ) {}
}

const OPAQUE = Symbol.for('@workflow/core//state-refs-opaque');
/**
 * Tags devalue decodes itself, such as `null` for null-prototype objects.
 * Recovery leaves them to devalue; only unknown custom types become
 * placeholders.
 */
const DEVALUE_BUILTIN_TAGS = new Set(['null', 'Object', 'DataView']);

function base64Bytes(value: string): ArrayBuffer {
  const text = globalThis.atob(value === '.' ? '' : value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes.buffer;
}

const typedArray =
  (Ctor: new (buffer: ArrayBuffer) => unknown) => (value: string) =>
    new Ctor(base64Bytes(value));

/**
 * Plain data types in the formats Workflow's own reducers write them, decoded
 * without Node built-ins, so state rebuilds the same way in a browser.
 * Callers' revivers take precedence.
 */
const VALUE_REVIVERS: Record<string, (value: any) => unknown> = {
  ArrayBuffer: base64Bytes,
  BigInt: (value: string) => BigInt(value),
  BigInt64Array: typedArray(BigInt64Array),
  BigUint64Array: typedArray(BigUint64Array),
  DataViewBytes: typedArray(DataView),
  Date: (value: string) => new Date(value),
  Float32Array: typedArray(Float32Array),
  Float64Array: typedArray(Float64Array),
  Int8Array: typedArray(Int8Array),
  Int16Array: typedArray(Int16Array),
  Int32Array: typedArray(Int32Array),
  Map: (value: Iterable<[unknown, unknown]>) => new Map(value),
  RegExp: (value: { source: string; flags: string }) =>
    new RegExp(value.source, value.flags),
  Set: (value: Iterable<unknown>) => new Set(value),
  URL: (value: string) => new URL(value),
  URLSearchParams: (value: string) =>
    new URLSearchParams(value === '.' ? '' : value),
  Uint8Array: typedArray(Uint8Array),
  Uint8ClampedArray: typedArray(Uint8ClampedArray),
  Uint16Array: typedArray(Uint16Array),
  Uint32Array: typedArray(Uint32Array),
};

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  // Byte views cannot be frozen; like dates they are replaced whole, never edited.
  if (ArrayBuffer.isView(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze((value as Dict)[key]);
}

function shallowCopy(value: unknown): unknown {
  // slice(), not spread: holes in a sparse array must stay holes.
  if (Array.isArray(value)) return value.slice();
  return Object.getPrototypeOf(value) === null
    ? Object.assign(Object.create(null) as Dict, value)
    : { ...(value as object) };
}

function jsonBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function checkedId(id: unknown, what: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID)
    throw new Error(`Invalid ${what}`);
  return id;
}

/**
 * Values that may sit inside tracked state without being frozen themselves.
 * `Date`, `Map` and `Set` can still be changed after freezing, and byte views
 * can't be frozen at all; they are trusted not to change, and are compared
 * and replaced whole (see the serialization docs). Immer freezes `Map` and
 * `Set` against changes and never drafts a `Date`.
 */
function isTrustedLeaf(value: object): boolean {
  if (ArrayBuffer.isView(value)) return true;
  // Not `instanceof`: values the workflow VM revives are made with its own
  // `Date`, `Map` and `Set`. The built-in tag reads their internal slots from
  // any realm without throwing; a brand check confirms one that claims to be
  // such a type, since a plain object can spoof the tag.
  switch (Object.prototype.toString.call(value)) {
    case '[object Date]':
      return hasBrand(() => Date.prototype.getTime.call(value));
    case '[object Map]':
      return hasBrand(() => Map.prototype.has.call(value, undefined));
    case '[object Set]':
      return hasBrand(() => Set.prototype.has.call(value, undefined));
    case '[object ArrayBuffer]':
      return hasBrand(() =>
        Reflect.apply(
          Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')
            ?.get as () => number,
          value,
          []
        )
      );
    default:
      return false;
  }
}

/** Whether a built-in method accepts a value, which only its own type does, from any realm. */
function hasBrand(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a trusted leaf holds only what tracked state may: a `Map` or `Set`
 * whose keys and values are primitives, trusted leaves or frozen state. A
 * class instance inside one couldn't be rebuilt without workflow code, so the
 * value holding it is stored in full. Not cached: a `Map` or `Set` can change.
 */
function holdsOnlyState(leaf: object, depth: number): boolean {
  const tag = Object.prototype.toString.call(leaf);
  if (tag !== '[object Map]' && tag !== '[object Set]') return true;
  if (depth > MAX_DEPTH) return false;
  let ok = true;
  const check = (entry: unknown) => {
    if (!ok) return;
    if (entry === null || typeof entry !== 'object') {
      if (typeof entry === 'function' || typeof entry === 'symbol') ok = false;
      return;
    }
    if (frozenState.has(entry)) return;
    if (isTrustedLeaf(entry)) {
      if (!holdsOnlyState(entry, depth + 1)) ok = false;
      return;
    }
    if (!isFrozenState(entry, depth + 1)) ok = false;
  };
  // The built-in methods, not the value's own: it may come from another realm.
  if (tag === '[object Map]')
    Map.prototype.forEach.call(leaf, (value: unknown, key: unknown) => {
      check(key);
      check(value);
    });
  else Set.prototype.forEach.call(leaf, (value: unknown) => check(value));
  return ok;
}

/** Plain objects and arrays already found deeply frozen; freezing can't be undone. */
const frozenState = globalSingleton(
  '@workflow/core//frozen-state',
  1,
  () => new WeakSet<object>()
);

/**
 * Whether a value is tracked state: a plain object or array, frozen, holding
 * only primitives, trusted leaves and more such values. Anything else (class
 * instances, functions, streams) is stored as it was before.
 */
export function isFrozenState(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (frozenState.has(value)) return true;
  if (depth > MAX_DEPTH || !Object.isFrozen(value)) return false;
  if (!Array.isArray(value) && !isPlainObject(value)) return false;
  // Freezing an accessor does not freeze the value it returns.
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return false;
  }
  const children = Array.isArray(value)
    ? value
    : Object.keys(value).map((key) => (value as Dict)[key]);
  for (const child of children) {
    if (child === null || typeof child !== 'object') {
      if (typeof child === 'function' || typeof child === 'symbol')
        return false;
      continue;
    }
    // Checked first: the children of a growing value are mostly known.
    if (frozenState.has(child)) continue;
    if (isTrustedLeaf(child)) {
      if (!holdsOnlyState(child, depth + 1)) return false;
      continue;
    }
    if (!isFrozenState(child, depth + 1)) return false;
  }
  frozenState.add(value);
  return true;
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** One invocation's view of the tracked values and sources in a run's log. */
export class StateContext {
  private readonly versions = new Map<string, Version>();
  /** The version each known value is, for writing references. */
  private readonly versionOf = new WeakMap<object, string>();
  /**
   * The newest version each known object is part of, for finding which
   * version a new frozen value was made from: its unchanged parts are objects
   * a known version already holds.
   */
  private readonly owners = new WeakMap<object, string>();
  /**
   * Known versions read most recently as step inputs. A step's output is
   * usually made from its input, so when a new value shares no objects with
   * a known version (state of strings and numbers, say), it is compared with
   * these by value instead.
   */
  private recentInputs: string[] = [];
  /** Registration order of versions, to prefer the newest when choosing a base. */
  private readonly order = new Map<string, number>();
  /** Objects inside a record being written, which are not records themselves. */
  private inside = new WeakSet<object>();
  /**
   * Payloads read without this run's log (run inputs and return values, hook
   * payloads) are written as plain values, so any reader can read them.
   */
  private standalone = false;
  /**
   * Whether changes refer to hook-payload strings. A context rebuilt by cold
   * recovery registers every hook payload in the log, but replay registers
   * only those it delivers, so only replay's context may refer to them.
   */
  writesSourceRefs = true;
  /**
   * Whether this context writes state records at all. Off for a step whose
   * run's workflow can't read them (a QuickJS run): see `STATE_REFS_FIELD`.
   */
  writesRecords = true;

  /**
   * A context for writing one step's output. It sees every version this
   * context knows, but the versions the step writes stay its own: they join
   * this context only when replay reads the step's committed `step_completed`.
   * Steps running side by side therefore never build on each other's
   * uncommitted output, which a reader of the log might not find.
   */
  forStep(): StateContext {
    const child = new StateContext();
    child.parent = this;
    child.registrations = this.registrations;
    child.sources = this.sources;
    child.strings = this.strings;
    child.recentInputs = [...this.recentInputs];
    child.standalone = this.standalone;
    child.writesSourceRefs = this.writesSourceRefs;
    child.writesRecords = this.writesRecords;
    // What reading the step's input cost, for its span.
    Object.assign(child.stats, this.stats);
    return child;
  }

  private version(id: string): Version | undefined {
    return this.versions.get(id) ?? this.parent?.version(id);
  }
  private versionOfValue(value: object): string | undefined {
    return this.versionOf.get(value) ?? this.parent?.versionOfValue(value);
  }
  private ownerOf(value: object): string | undefined {
    return this.owners.get(value) ?? this.parent?.ownerOf(value);
  }
  private rank(version: string): number {
    return this.order.get(version) ?? this.parent?.rank(version) ?? 0;
  }

  /** A context for payloads read without the run's log: it writes no records. */
  static standalone(): StateContext {
    const context = new StateContext();
    context.standalone = true;
    return context;
  }
  /**
   * Each source's referenceable strings by path, captured when the source is
   * first seen. Code may edit a revived hook payload or run input later; state
   * changes must still resolve to the strings that were stored.
   */
  private sources = new Map<string, Map<string, string>>();
  private strings = new Map<string, SourceString>();
  /**
   * The context a step's output is written against (see `forStep`): its
   * versions can be bases and references; this context's own versions are
   * the step's, until replay reads them back from the committed log.
   */
  private parent: StateContext | undefined;
  /**
   * Registration order, shared with the layers made from this context, so a
   * step's versions rank after the ones it can see.
   */
  private registrations = { count: 0 };
  readonly stats = {
    refs: 0,
    patches: 0,
    full: 0,
    sourceRefs: 0,
    recoveryFetches: 0,
    recoveryBytes: 0,
    recoveryMs: 0,
  };

  /** Starts writing one payload: what counted as inside its records is forgotten. */
  beginWrite(): void {
    this.inside = new WeakSet();
  }

  /** devalue reducer: returns a record for tracked values, `false` otherwise. */
  reduce = (value: unknown): unknown => this.reduceValue(value, true);

  /**
   * devalue reducer for a step input. Its versions are written like any
   * other, but not remembered: no reader reads step inputs back, so a later
   * payload must not refer to them.
   */
  reduceInput = (value: unknown): unknown => this.reduceValue(value, false);

  private reduceValue(value: unknown, register: boolean): unknown {
    if (value === null || typeof value !== 'object') return false;
    if (this.inside.has(value)) {
      // Part of a record already being written: stored inline, as is.
      this.markInside(value);
      return false;
    }
    // Not written for the QuickJS VM, nor for payloads read without the log;
    // reading records is always supported.
    if (
      this.standalone ||
      !this.writesRecords ||
      !stateRefsEnabled() ||
      !isFrozenState(value)
    )
      return false;
    return this.reduceTracked(value, register);
  }

  /** Marks a value's children as part of the record being written. */
  private markInside(value: object): void {
    if (isTrustedLeaf(value)) return;
    const children = Array.isArray(value)
      ? value
      : Object.keys(value).map((key) => (value as Dict)[key]);
    for (const child of children)
      if (child !== null && typeof child === 'object' && !this.isKnown(child))
        this.inside.add(child);
  }

  /** A version this context can write a reference to. */
  private isKnown(value: object): boolean {
    const version = this.versionOfValue(value);
    return version !== undefined && this.version(version) !== undefined;
  }

  /** Marks the values a change carries as part of the record being written. */
  private markOps(ops: readonly StateOp[]): void {
    for (const op of ops) {
      const carried =
        op.op === 'set' ? [op.value] : op.op === 'append' ? op.items : [];
      for (const value of carried)
        if (value !== null && typeof value === 'object' && !this.isKnown(value))
          this.inside.add(value);
    }
  }

  /**
   * The known version a new frozen value was most likely made from: the one
   * most of its unchanged parts belong to, newest first on a tie. Only the
   * value's new objects are walked, down to the first known object on each
   * path. A known version held whole is contained, not built on: it is
   * written as its own reference inside the record.
   */
  private findBase(value: object): string | undefined {
    const counts = new Map<string, number>();
    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === null || typeof node !== 'object') continue;
      if (node !== value && this.versionOfValue(node) !== undefined) continue;
      const owner = node === value ? undefined : this.ownerOf(node);
      if (owner !== undefined) {
        counts.set(owner, (counts.get(owner) ?? 0) + 1);
        continue;
      }
      if (isTrustedLeaf(node)) continue;
      // A loop, not a spread: spreading a large array overflows the stack.
      if (Array.isArray(node)) for (const child of node) stack.push(child);
      else for (const key of Object.keys(node)) stack.push((node as Dict)[key]);
    }
    if (counts.size === 0) return this.closestInput(value);
    let best: string | undefined;
    for (const [version, count] of counts) {
      if (this.version(version) === undefined) continue;
      const bestCount = best === undefined ? -1 : (counts.get(best) as number);
      if (
        count > bestCount ||
        (count === bestCount && this.rank(version) > this.rank(best as string))
      )
        best = version;
    }
    return best;
  }

  /**
   * Of the versions recently read as step inputs, the one a new value differs
   * least from, unless every one would be replaced whole.
   */
  private closestInput(value: object): string | undefined {
    let best: string | undefined;
    let bestBytes = Number.POSITIVE_INFINITY;
    for (const version of this.recentInputs) {
      const entry = this.version(version);
      if (entry === undefined) continue;
      const ops = diffState(entry.value, value);
      if (ops.some((op) => op.op === 'set' && op.path.length === 0)) continue;
      const bytes = opsBytes(ops);
      if (bytes < bestBytes) {
        best = version;
        bestBytes = bytes;
      }
    }
    return best;
  }

  /** Remembers a version, its value, and which objects it holds. */
  private register(version: string, entry: Version): void {
    this.versions.set(version, entry);
    this.order.set(version, ++this.registrations.count);
    const { value } = entry;
    if (value === null || typeof value !== 'object') return;
    this.versionOf.set(value, version);
    // Objects already known belong to this newer version too; their insides
    // were indexed when first seen.
    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === null || typeof node !== 'object') continue;
      const known = this.ownerOf(node) !== undefined;
      this.owners.set(node, version);
      if (known || isTrustedLeaf(node)) continue;
      // A loop, not a spread: spreading a large array overflows the stack.
      if (Array.isArray(node)) for (const child of node) stack.push(child);
      else for (const key of Object.keys(node)) stack.push((node as Dict)[key]);
    }
  }

  /** devalue reducer for the strings inside a state change that a source already holds. */
  reduceSourceRef = (value: unknown): unknown =>
    value instanceof StateSourceRef ? [value.id, value.path] : false;

  reviveSourceRef = ([id, path]: [
    string,
    (string | number)[],
  ]): StateSourceRef =>
    new StateSourceRef(checkedId(id, 'state source id'), path);

  revive = (d: Dict): unknown => this.reviveRecord(d, true);

  /** devalue reviver for a step input: rebuilds its values without remembering them (see `reduceInput`). */
  reviveInput = (d: Dict): unknown => this.reviveRecord(d, false);

  private reviveRecord(d: Dict, register: boolean): unknown {
    switch (d.kind) {
      case 'source':
        // Written by earlier previews of this feature; still readable.
        return this.reviveSource(d);
      case 'ref':
      case 'patch':
      case 'full':
        return this.reviveTracked(d, register);
      default:
        throw new Error('Unknown workflow state record');
    }
  }

  private reduceTracked(value: object, register: boolean): unknown {
    const known = this.versionOfValue(value);
    const knownEntry = known === undefined ? undefined : this.version(known);
    if (known !== undefined && knownEntry !== undefined) {
      this.stats.refs++;
      return { kind: 'ref', logId: knownEntry.logId, version: known };
    }
    const baseVersion = this.findBase(value);
    const base =
      baseVersion === undefined ? undefined : this.version(baseVersion);
    if (baseVersion !== undefined && base !== undefined) {
      const ops = diffState(base.value, value);
      // The same data as a known version, in new objects: refer to it.
      if (ops.length === 0) {
        if (register) this.versionOf.set(value, baseVersion);
        this.stats.refs++;
        return { kind: 'ref', logId: base.logId, version: baseVersion };
      }
      const bytesSinceFull = base.bytesSinceFull + opsBytes(ops);
      const recordsSinceFull = base.recordsSinceFull + 1;
      const rule = this.snapshotRule(value, bytesSinceFull, base.measured);
      const { measured } = rule;
      const snapshot =
        rule.snapshot || recordsSinceFull >= SNAPSHOT_MAX_RECORDS;
      // A change that replaces the whole value is stored as that value: its
      // `set` would otherwise hold the value itself, which devalue would
      // encode as a reference back to this record.
      const replacesWhole = ops.some(
        (op) => op.op === 'set' && op.path.length === 0
      );
      if (!snapshot && !replacesWhole) {
        const version = newId();
        if (register)
          this.register(version, {
            logId: base.logId,
            value,
            bytesSinceFull,
            recordsSinceFull,
            measured,
          });
        this.stats.patches++;
        this.markOps(ops);
        return {
          kind: 'patch',
          logId: base.logId,
          base: baseVersion,
          version,
          ops: this.withSourceRefs(ops),
        };
      }
      return this.writeFull(value, base.logId, register, measured);
    }
    return this.writeFull(value, newId(), register, undefined);
  }

  private writeFull(
    value: object,
    logId: string,
    register: boolean,
    measured: Measured | undefined
  ): unknown {
    const version = newId();
    if (register)
      this.register(version, {
        logId,
        value,
        bytesSinceFull: 0,
        recordsSinceFull: 0,
        measured: measured && { bytes: measured.bytes, at: 0 },
      });
    this.stats.full++;
    this.markInside(value);
    return { kind: 'full', logId, version, value: shallowCopy(value) };
  }

  /**
   * Whether to write the value whole: its changes since the last whole value
   * exceed {@link SNAPSHOT_MIN_BYTES} and half its size. Measuring the size
   * serializes the whole value, so a measurement is reused while the changes
   * since it cannot have grown enough for the rule to fire.
   */
  private snapshotRule(
    value: unknown,
    bytesSinceFull: number,
    measured: Measured | undefined
  ): { snapshot: boolean; measured: Measured | undefined } {
    if (bytesSinceFull <= SNAPSHOT_MIN_BYTES)
      return { snapshot: false, measured };
    if (measured !== undefined && bytesSinceFull >= measured.at) {
      // Each change moves the size by about its own bytes, so the value is
      // at least this big; while the rule can't fire against that, skip it.
      const atLeast = measured.bytes - (bytesSinceFull - measured.at);
      if (2 * bytesSinceFull <= atLeast) return { snapshot: false, measured };
    }
    const bytes = jsonBytes(value);
    return {
      snapshot: 2 * bytesSinceFull > bytes,
      measured: { bytes, at: bytesSinceFull },
    };
  }

  private reviveTracked(d: Dict, register: boolean): unknown {
    const logId = checkedId(d.logId, 'workflow state log');
    const version = checkedId(d.version, 'workflow state version');
    const known = this.version(version);
    if (d.kind === 'ref') {
      if (known?.logId !== logId)
        throw new WorkflowStateMissingError(
          `Missing workflow state version ${logId}:${version}`
        );
      if (!register) {
        this.recentInputs = [
          version,
          ...this.recentInputs.filter((v) => v !== version),
        ].slice(0, MAX_RECENT_INPUTS);
      }
      return known.value;
    }
    if (known !== undefined) return known.value;
    let value: unknown;
    let bytesSinceFull = 0;
    let recordsSinceFull = 0;
    if (d.kind === 'full') {
      value = d.value;
      this.assertKnownTypes(value);
    } else {
      const base =
        typeof d.base === 'string' ? this.version(d.base) : undefined;
      if (base?.logId !== logId)
        throw new WorkflowStateMissingError(
          `Missing workflow state base ${logId}:${String(d.base)}`
        );
      if (!Array.isArray(d.ops))
        throw new Error('Invalid workflow state change');
      const ops = this.resolveSourceRefs(d.ops) as StateOp[];
      // The base was checked when it was registered; only the change is new.
      // Checking the whole value would walk the history on every revive.
      this.assertKnownTypes(ops);
      value = applyStateOps(base.value, ops);
      bytesSinceFull = base.bytesSinceFull + opsBytes(ops);
      recordsSinceFull = base.recordsSinceFull + 1;
    }
    // A value built around a placeholder (inspection only) is not the stored
    // value: keep it out of the context so a later read can rebuild it.
    if (this.placeholders.size > 0 && this.holdsPlaceholder(value))
      return value;
    deepFreeze(value);
    if (register)
      this.register(version, {
        logId,
        value,
        bytesSinceFull,
        recordsSinceFull,
      });
    return value;
  }

  /**
   * Registers the long strings of a payload later state may refer to: a hook
   * payload or the run input, as read, under its `stateSourceId`. Every
   * reader of the log registers the same payloads under the same ids.
   */
  addSource(id: string, value: unknown): void {
    checkedId(id, 'state source id');
    if (this.sources.has(id)) return;
    const captured = new Map<string, string>();
    this.sources.set(id, captured);
    const walk = (v: unknown, path: (string | number)[]) => {
      if (path.length > MAX_PATH) return;
      if (typeof v === 'string') {
        if (v.length < SOURCE_STRING_MIN) return;
        captured.set(JSON.stringify(path), v);
        if (!this.strings.has(v)) this.strings.set(v, { id, path });
      } else if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) walk(v[i], [...path, i]);
      } else if (isPlainObject(v)) {
        for (const key of Object.keys(v)) walk(v[key], [...path, key]);
      }
    };
    walk(value, []);
  }

  private reviveSource(d: Dict): unknown {
    const id = checkedId(d.id, 'state source id');
    this.addSource(id, d.value);
    return d.value;
  }

  /** Replaces long strings a source already holds; the result is serialized, never kept. */
  private withSourceRefs(ops: readonly StateOp[]): unknown[] {
    if (!this.writesSourceRefs || this.strings.size === 0) return [...ops];
    const replace = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const at =
          v.length >= SOURCE_STRING_MIN ? this.strings.get(v) : undefined;
        if (at === undefined) return v;
        this.stats.sourceRefs++;
        return new StateSourceRef(at.id, at.path);
      }
      if (Array.isArray(v)) return v.map(replace);
      if (isPlainObject(v)) {
        const out: Dict =
          Object.getPrototypeOf(v) === null ? Object.create(null) : {};
        for (const key of Object.keys(v)) out[key] = replace(v[key]);
        return out;
      }
      return v;
    };
    return ops.map(replace);
  }

  private resolveSourceRefs(v: unknown): unknown {
    if (v instanceof StateSourceRef) {
      const captured = this.sources.get(v.id);
      if (captured === undefined)
        throw new WorkflowStateMissingError(
          `Missing workflow state source ${v.id}`
        );
      const value = captured.get(JSON.stringify(v.path));
      if (value === undefined)
        throw new WorkflowStateMissingError(
          'Missing workflow state source field'
        );
      return value;
    }
    if (Array.isArray(v)) return v.map((x) => this.resolveSourceRefs(x));
    // Keep recovery placeholders as they are: copying by `Object.keys` would
    // drop their symbol marker and let them pass `assertKnownTypes` as `{}`.
    if ((v as Dict | null)?.[OPAQUE as unknown as string] === true) return v;
    if (isPlainObject(v)) {
      const out: Dict =
        Object.getPrototypeOf(v) === null ? Object.create(null) : {};
      for (const key of Object.keys(v))
        out[key] = this.resolveSourceRefs(v[key]);
      return out;
    }
    return v;
  }

  /** Inspection tools display values that recovery would refuse to rebuild. */
  allowPlaceholders = false;

  /** Placeholders handed out for records this context could not rebuild (inspection only). */
  private readonly placeholders = new Set<string>();

  /** The display placeholder for a record that could not be rebuilt yet. */
  placeholderFor(record: Dict): unknown {
    if (record.kind === 'source' || record.kind === 'full') return record.value;
    const text = `<workflow/state ${String(record.version)}>`;
    this.placeholders.add(text);
    return text;
  }

  private holdsPlaceholder(value: unknown, depth = 0): boolean {
    if (typeof value === 'string') return this.placeholders.has(value);
    if (depth > 256 || value === null || typeof value !== 'object')
      return false;
    for (const key of Object.keys(value))
      if (this.holdsPlaceholder((value as Dict)[key], depth + 1)) return true;
    return false;
  }

  private assertKnownTypes(value: unknown, depth = 0): void {
    if (this.allowPlaceholders) return;
    if (depth > 256 || value === null || typeof value !== 'object') return;
    if ((value as Dict)[OPAQUE as unknown as string] === true)
      throw new Error(
        'Workflow state holds a value that cannot be recovered without running workflow code'
      );
    // Placeholders can sit inside a Map or Set as well as an object.
    const tag = Object.prototype.toString.call(value);
    if (tag === '[object Map]')
      Map.prototype.forEach.call(value, (entry: unknown, key: unknown) => {
        this.assertKnownTypes(key, depth + 1);
        this.assertKnownTypes(entry, depth + 1);
      });
    else if (tag === '[object Set]')
      Set.prototype.forEach.call(value, (entry: unknown) =>
        this.assertKnownTypes(entry, depth + 1)
      );
    else
      for (const key of Object.keys(value))
        this.assertKnownTypes((value as Dict)[key], depth + 1);
  }

  /**
   * Cold recovery: reads the state records of one decoded payload (JSON text after
   * the format prefix) without running workflow code. Other custom types become
   * placeholders, which fail loudly if they end up inside tracked state.
   */
  ingest(
    payload: Uint8Array,
    common: Record<string, (value: any) => unknown> = {},
    source?: string
  ): void {
    const text = new TextDecoder().decode(payload);
    if (source === undefined && !text.includes(STATE_REF_REDUCER)) return;
    const opaque = () => ({ [OPAQUE]: true });
    // `common` revives types encoded by Workflow's own reducers (dates, maps,
    // typed arrays, or display versions of them); anything else that needs
    // workflow code (streams, class instances) becomes a placeholder.
    // State records always go to this context, even if `common` has its own
    // (display) revivers for them.
    const pick = (key: string | symbol) =>
      typeof key !== 'string'
        ? undefined
        : key === STATE_REF_REDUCER
          ? this.revive
          : key === STATE_SOURCE_REDUCER
            ? this.reviveSourceRef
            : Object.hasOwn(common, key)
              ? common[key]
              : Object.hasOwn(VALUE_REVIVERS, key)
                ? VALUE_REVIVERS[key]
                : DEVALUE_BUILTIN_TAGS.has(key)
                  ? undefined
                  : opaque;
    const revivers = new Proxy({} as Record<string, (v: any) => unknown>, {
      get: (_t, key) => pick(key),
      has: (_t, key) => pick(key) !== undefined,
      getOwnPropertyDescriptor: (_t, key) => {
        const value = pick(key);
        return value === undefined
          ? undefined
          : { value, enumerable: true, configurable: true };
      },
    });
    const value = parse(text, revivers);
    if (source !== undefined) this.addSource(source, value);
  }

  /**
   * Whether reading this decoded payload needs records this context lacks.
   * Reads it like `ingest`, into a scratch copy, so nothing is remembered.
   */
  needsRecovery(payload: Uint8Array): boolean {
    const text = new TextDecoder().decode(payload);
    if (!text.includes(STATE_REF_REDUCER)) return false;
    const scratch = new StateContext();
    for (const [id, version] of this.versions)
      scratch.versions.set(id, version);
    for (const [id, strings] of this.sources) scratch.sources.set(id, strings);
    try {
      scratch.ingest(payload);
      return false;
    } catch {
      // Any failure may hide a missing record behind it (a value the scratch
      // read can't revive, say). Recovering costs a log read; skipping it when
      // a record is missing fails the step.
      return true;
    }
  }
}

/** Whether references are written here; reading them always works. */
export function stateRefsEnabled(): boolean {
  // The QuickJS workflow VM decodes payloads with its own codec, which does not
  // read state records yet, so references are not written for it.
  return process.env.WORKFLOW_VM !== 'quickjs';
}

const bindings = globalSingleton(
  '@workflow/core//state-ref-contexts',
  1,
  () => ({
    globals: new WeakMap<object, StateContext>(),
    data: new WeakMap<object, StateContext>(),
  })
);
export function bindStateContext(global: object, context: StateContext): void {
  bindings.globals.set(global, context);
}
export function stateContextForGlobal(
  global: object
): StateContext | undefined {
  return bindings.globals.get(global);
}
/** Registers a payload replay just read with the session's context (see `addSource`). */
export function registerStateSource(
  global: object,
  source: string | undefined,
  value: unknown
): void {
  if (source !== undefined)
    bindings.globals.get(global)?.addSource(source, value);
}
export function bindStateContextData(
  data: unknown,
  context: StateContext | undefined
): void {
  if (data !== null && typeof data === 'object' && context)
    bindings.data.set(data, context);
}
export function stateContextForData(data: unknown): StateContext | undefined {
  return data !== null && typeof data === 'object'
    ? bindings.data.get(data)
    : undefined;
}

/** Span attributes for reading a step input: what rebuilding its state cost. */
export function stateHydrateAttributes(
  context: StateContext | undefined
): Record<string, number> {
  if (context === undefined) return {};
  const { recoveryFetches, recoveryBytes, recoveryMs } = context.stats;
  return {
    'workflow.state_refs.recovery_fetches': recoveryFetches,
    'workflow.state_refs.recovery_bytes': recoveryBytes,
    'workflow.state_refs.recovery_ms': recoveryMs,
  };
}

type WriteCounts = Pick<
  StateContext['stats'],
  'refs' | 'patches' | 'full' | 'sourceRefs'
>;

/** The context's write counts so far, to diff against after one write. */
export function stateWriteCounts(
  context: StateContext | undefined
): WriteCounts | undefined {
  if (context === undefined) return undefined;
  const { refs, patches, full, sourceRefs } = context.stats;
  return { refs, patches, full, sourceRefs };
}

/** Span attributes for writing a step output: the records it was stored as. */
export function stateDehydrateAttributes(
  context: StateContext | undefined,
  before: WriteCounts | undefined
): Record<string, number> {
  const after = stateWriteCounts(context);
  if (after === undefined || before === undefined) return {};
  return {
    'workflow.state_refs.refs': after.refs - before.refs,
    'workflow.state_refs.patches': after.patches - before.patches,
    'workflow.state_refs.full': after.full - before.full,
    'workflow.state_refs.source_refs': after.sourceRefs - before.sourceRefs,
  };
}
