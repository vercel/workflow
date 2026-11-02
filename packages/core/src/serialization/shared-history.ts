import { globalSingleton } from '@workflow/utils';
import {
  type HistoryCursor,
  type HistorySource,
  historyMark,
  SHARED_HISTORY_MARK,
  SharedHistory,
} from '../shared-history.js';

const MAX_ENTRIES = 100_000;
const MAX_PATH = 64;
type RecordValue = Record<string, any>;
function checkedCursor(d: RecordValue): void {
  if (
    typeof d.logId !== 'string' ||
    d.logId.length > 256 ||
    !Number.isSafeInteger(d.end) ||
    d.end < 0 ||
    d.end > MAX_ENTRIES
  ) {
    throw new Error('Invalid shared history cursor');
  }
}
function resolvePath(value: any, path: readonly (string | number)[]): any {
  if (!Array.isArray(path) || path.length > MAX_PATH)
    throw new Error('Invalid history path');
  for (const key of path) {
    if (
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype' ||
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key)
    ) {
      throw new Error('Missing shared history field');
    }
    value = value[key];
  }
  return value;
}
function tagOrigin(
  value: any,
  sourceId: string,
  path: (string | number)[] = []
): void {
  if (!value || typeof value !== 'object') return;
  if (path.length > MAX_PATH)
    throw new Error('History entry is too deeply nested');
  Object.defineProperty(value, SHARED_HISTORY_MARK, {
    value: { kind: 'ref', sourceId, path },
    configurable: true,
  });
  for (const key of Object.keys(value))
    tagOrigin(value[key], sourceId, [...path, key]);
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze((value as RecordValue)[key]);
}

const MAX_STATE_CHAIN = 100_000;
type Dict = Record<string, unknown>;

/** Eve's notion of a plain object: an object literal or a dictionary, from any realm. */
function isPlainObject(value: unknown): value is Dict {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}
function objectLike(like: Dict, entries: [string, unknown][]): Dict {
  const object = Object.fromEntries(entries);
  return Object.getPrototypeOf(like) === null
    ? Object.assign(Object.create(null) as Dict, object)
    : object;
}
/**
 * Copies plain objects and arrays, keeping dictionaries null-prototype and
 * other values by reference (Eve's `snapshotValue`). A revived state value is
 * a copy because step code may edit its input in place.
 */
export function copyStateValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => copyStateValue(v)) as T;
  if (!isPlainObject(value)) return value;
  return objectLike(
    value,
    Object.keys(value).map((k) => [k, copyStateValue(value[k])])
  ) as T;
}
/**
 * Applies one of Eve's `ValueDelta`s (`{ kind: 'value' | 'array' | 'object' }`
 * with `set` / `patch` / `keys` / `length`) without mutating `base`. This must
 * stay identical to Eve's `applyValueDelta`.
 */
export function applyStateDelta(base: unknown, delta: unknown): unknown {
  if (delta === undefined) return base;
  const d = delta as Dict;
  switch (d.kind) {
    case 'value':
      return d.value;
    case 'array': {
      if (!Array.isArray(base))
        throw new Error(
          'State delta does not match its base: expected an array.'
        );
      const next = base.slice(0, d.length as number);
      for (const [i, v] of Object.entries((d.set as Dict) ?? {}))
        next[Number(i)] = v;
      for (const [i, change] of Object.entries((d.patch as Dict) ?? {}))
        next[Number(i)] = applyStateDelta(base[Number(i)], change);
      return next;
    }
    case 'object': {
      if (!isPlainObject(base))
        throw new Error(
          'State delta does not match its base: expected an object.'
        );
      const set = (d.set as Dict) ?? {};
      const patch = (d.patch as Dict) ?? {};
      const baseKeys = Object.keys(base);
      let keys = d.keys as string[] | undefined;
      if (!keys) {
        const known = new Set(baseKeys);
        const added = Object.keys(set).filter((k) => !known.has(k));
        keys = added.length === 0 ? baseKeys : [...baseKeys, ...added];
      }
      return objectLike(
        base,
        keys.map((k) => {
          if (k === '__proto__') throw new Error('Invalid state delta key');
          if (Object.hasOwn(set, k)) return [k, set[k]];
          if (Object.hasOwn(patch, k))
            return [k, applyStateDelta(base[k], patch[k])];
          return [k, base[k]];
        })
      );
    }
    default:
      throw new Error('Unknown state delta');
  }
}

/** One invocation's materialized views over flat hook/step log segments. */
export class SharedHistoryContext {
  private readonly sources = new Map<string, unknown>();
  private readonly segments = new Map<string, Map<number, RecordValue>>();
  private readonly prefixes = new Map<string, unknown[]>();
  /** Session values by `logId:version`, adopted from replay or reconstructed. */
  private readonly states = new Map<string, unknown>();
  /** Committed state transitions by version. */
  private readonly stateSegments = new Map<string, RecordValue>();
  readonly stats = {
    adoptedStates: 0,
    reconstructedStates: 0,
    adoptedPrefixes: 0,
    reconstructedPrefixes: 0,
    recoveryFetches: 0,
  };

  source(ref: HistorySource): unknown {
    if (!this.sources.has(ref.sourceId))
      throw new Error(`Missing history source: ${ref.sourceId}`);
    return resolvePath(this.sources.get(ref.sourceId), ref.path);
  }
  adopt(values: unknown[], cursor: HistoryCursor): void {
    checkedCursor(cursor);
    if (values.length !== cursor.end)
      throw new Error('History prefix length mismatch');
    this.prefixes.set(`${cursor.logId}:${cursor.end}`, values);
    this.stats.adoptedPrefixes++;
  }
  reduce(value: unknown): unknown {
    const m = historyMark(value);
    if (!m) return false;
    switch (m.kind) {
      case 'prefix':
        // Only a context that saw the producing segments (this run's replay)
        // may write a cursor; anywhere else, such as another run's start()
        // input during a session handoff, the array is serialized in full.
        if (!this.canResolvePrefix(m.logId, m.end)) return false;
        this.adopt(value as unknown[], m);
        return m;
      case 'source':
        return {
          ...m,
          value: Array.isArray(value) ? [...value] : { ...(value as object) },
        };
      case 'append':
        return { ...m, value: { ...(value as object) } };
      case 'ref':
        return m;
      case 'state': {
        // The unrooted starting value is stored once, in full; later versions
        // are owned by the step outputs that produced them.
        // Same rule as prefixes: a cursor only where its segment is known.
        if (m.version === null || !this.stateSegments.has(m.version))
          return { ...m, version: null, value: copyStateValue(value) };
        this.states.set(`${m.logId}:${m.version}`, value);
        this.stats.adoptedStates++;
        return m;
      }
      case 'stateDelta': {
        // The producer knows its own segment, so a context that writes it can
        // later write cursors to it (the inline step's output goes through the
        // run's replay context).
        const record = { ...m, value: { ...(value as object) } };
        const existing = this.stateSegments.get(m.version);
        if (
          existing &&
          (existing.base !== m.base || existing.logId !== m.logId)
        )
          throw new Error('Conflicting state version');
        this.stateSegments.set(m.version, record);
        return record;
      }
      case 'projection': {
        const rest = { ...(value as RecordValue) };
        for (const key of Object.keys(m.fields)) delete rest[key];
        return { ...m, rest };
      }
    }
  }
  revive = (d: RecordValue): unknown => {
    switch (d.kind) {
      case 'source': {
        if (typeof d.sourceId !== 'string' || d.sourceId.length > 256)
          throw new Error('Invalid history source');
        if (this.sources.has(d.sourceId))
          throw new Error('Duplicate history source in event log');
        tagOrigin(d.value, d.sourceId);
        // Later views serialize a `ref` to this producer instead of its bytes,
        // so an in-place edit would be lost on cold recovery. Freeze it so
        // such an edit fails loudly rather than diverging silently.
        deepFreeze(d.value);
        this.sources.set(d.sourceId, d.value);
        return d.value;
      }
      case 'ref':
        return this.source(d as unknown as HistorySource);
      case 'projection': {
        const result = { ...d.rest };
        for (const [key, ref] of Object.entries(
          d.fields as Record<string, HistorySource>
        )) {
          Object.defineProperty(result, key, {
            value: this.source(ref),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return SharedHistory.project(result, d.fields);
      }
      case 'append': {
        checkedCursor(d);
        if (!Number.isSafeInteger(d.start) || d.start < 0 || d.start > d.end)
          throw new Error('Invalid history segment');
        // The physical log contains disjoint ranges, not pointers to predecessors.
        if (!this.segments.has(d.logId)) this.segments.set(d.logId, new Map());
        const log = this.segments.get(d.logId)!;
        if (log.has(d.start)) throw new Error('Overlapping history segment');
        log.set(d.start, d);
        return SharedHistory.append(
          d.value,
          { logId: d.logId, end: d.start },
          d.end
        );
      }
      case 'state': {
        if (typeof d.logId !== 'string' || d.logId.length > 256)
          throw new Error('Invalid state log');
        if (d.version === null) {
          return SharedHistory.state(d.value as object, {
            logId: d.logId,
            version: null,
          });
        }
        if (typeof d.version !== 'string')
          throw new Error('Invalid state version');
        const value = this.state(d.logId, d.version);
        return SharedHistory.state(copyStateValue(value) as object, {
          logId: d.logId,
          version: d.version,
        });
      }
      case 'stateDelta': {
        if (
          typeof d.logId !== 'string' ||
          typeof d.version !== 'string' ||
          (d.base !== null && typeof d.base !== 'string')
        )
          throw new Error('Invalid state segment');
        const existing = this.stateSegments.get(d.version);
        if (
          existing &&
          (existing.base !== d.base || existing.logId !== d.logId)
        )
          throw new Error('Conflicting state version');
        this.stateSegments.set(d.version, d);
        return SharedHistory.stateDelta(d.value as object, {
          logId: d.logId,
          base: d.base,
          version: d.version,
        });
      }
      case 'prefix': {
        checkedCursor(d);
        const key = `${d.logId}:${d.end}`;
        let prefix = this.prefixes.get(key);
        if (!prefix) {
          prefix = [];
          const log = this.segments.get(d.logId);
          while (prefix.length < d.end) {
            const part = log?.get(prefix.length);
            if (!part || part.end <= prefix.length || part.end > d.end)
              throw new Error('Incomplete history prefix');
            const delta = part.value;
            if (
              delta.kind === 'value' &&
              prefix.length === 0 &&
              Array.isArray(delta.value)
            )
              prefix.push(...delta.value);
            else if (
              delta.kind === 'array' &&
              delta.patch === undefined &&
              delta.length === part.end
            ) {
              for (let i = part.start; i < part.end; i++) {
                if (!Object.hasOwn(delta.set ?? {}, String(i)))
                  throw new Error('Non-contiguous history segment');
                prefix.push(delta.set[String(i)]);
              }
            } else throw new Error('History rewrite requires a new log');
          }
          this.prefixes.set(key, prefix);
          this.stats.reconstructedPrefixes++;
        }
        return SharedHistory.prefix(prefix, { logId: d.logId, end: d.end });
      }
      default:
        throw new Error('Unknown shared history record');
    }
  };

  /** Whether committed segments (or an adopted prefix) cover `[0, end)`. */
  private canResolvePrefix(logId: string, end: number): boolean {
    if (end === 0 || this.prefixes.has(`${logId}:${end}`)) return true;
    const log = this.segments.get(logId);
    let at = 0;
    while (at < end) {
      const part = log?.get(at);
      if (!part || part.end <= at) return false;
      at = part.end as number;
    }
    return at === end;
  }

  /**
   * A session value at `version`: the one replay adopted, or the fold of the
   * committed segments from the chain's whole-value root.
   */
  private state(logId: string, version: string): unknown {
    const key = `${logId}:${version}`;
    if (this.states.has(key)) return this.states.get(key);
    const chain: RecordValue[] = [];
    let at: string | null = version;
    let base: unknown;
    let found = false;
    while (at !== null) {
      const cached = `${logId}:${at}`;
      if (this.states.has(cached) && chain.length > 0) {
        base = this.states.get(cached);
        found = true;
        break;
      }
      const seg = this.stateSegments.get(at);
      if (!seg || seg.logId !== logId)
        throw new Error(`Missing state version: ${logId}:${at}`);
      chain.push(seg);
      if (chain.length > MAX_STATE_CHAIN)
        throw new Error('State chain is too long');
      at = seg.base as string | null;
    }
    if (!found) {
      const root = chain[chain.length - 1]!;
      if ((root.value as RecordValue | undefined)?.kind !== 'value')
        throw new Error('State chain root must be a whole value');
    }
    let value = base;
    for (const seg of chain.reverse()) {
      value = applyStateDelta(value, seg.value);
      this.states.set(`${logId}:${seg.version}`, value);
    }
    this.stats.reconstructedStates++;
    return value;
  }

  /** Recovery parses only the JSON log records, without running workflow code. */
  ingestPrepared(data: Uint8Array): void {
    const text = new TextDecoder().decode(data.subarray(4));
    const table: unknown = JSON.parse(text);
    if (!Array.isArray(table)) return;
    const cache = new Map<number, any>();
    const decode = (n: number, depth = 0): any => {
      if (depth > 128) throw new Error('History record nesting limit');
      if (n === -1) return undefined;
      if (n < 0) throw new Error('History entries must be finite JSON values');
      if (cache.has(n)) return cache.get(n);
      const raw = table[n];
      if (raw === null || typeof raw !== 'object') return raw;
      if (Array.isArray(raw)) {
        if (raw[0] === 'SharedHistoryV1') {
          const value = this.revive(decode(raw[1], depth + 1));
          cache.set(n, value);
          return value;
        }
        if (raw[0] === 'null') {
          // devalue's null-prototype object: ["null", key, index, ...]
          const dict: RecordValue = Object.create(null);
          cache.set(n, dict);
          for (let i = 1; i + 1 < raw.length; i += 2) {
            if (typeof raw[i] !== 'string' || raw[i] === '__proto__')
              throw new Error('Invalid dictionary entry');
            dict[raw[i] as string] = decode(raw[i + 1] as number, depth + 1);
          }
          return dict;
        }
        if (typeof raw[0] === 'string')
          throw new Error('History entries must be JSON values');
        const value: unknown[] = [];
        cache.set(n, value);
        for (const v of raw) value.push(decode(v, depth + 1));
        return value;
      }
      const value: RecordValue = {};
      cache.set(n, value);
      for (const [key, v] of Object.entries(raw)) {
        Object.defineProperty(value, key, {
          value: decode(v as number, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return value;
    };
    for (let i = 0; i < table.length; i++) {
      const row = table[i];
      if (Array.isArray(row) && row[0] === 'SharedHistoryV1') decode(i);
    }
  }
}

const bindings = globalSingleton(
  '@workflow/core//shared-history-contexts',
  1,
  () => ({
    globals: new WeakMap<object, SharedHistoryContext>(),
    data: new WeakMap<object, SharedHistoryContext>(),
  })
);
export function bindSharedHistory(
  global: object,
  context: SharedHistoryContext
): void {
  bindings.globals.set(global, context);
}
export function sharedHistoryForGlobal(
  global: object
): SharedHistoryContext | undefined {
  return bindings.globals.get(global);
}
export function bindSharedHistoryData(
  data: unknown,
  context: SharedHistoryContext | undefined
): void {
  if (data && typeof data === 'object' && context)
    bindings.data.set(data, context);
}
export function sharedHistoryForData(
  data: unknown
): SharedHistoryContext | undefined {
  return data && typeof data === 'object' ? bindings.data.get(data) : undefined;
}
