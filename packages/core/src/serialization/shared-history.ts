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

/** One invocation's materialized views over flat hook/step log segments. */
export class SharedHistoryContext {
  private readonly sources = new Map<string, unknown>();
  private readonly segments = new Map<string, Map<number, RecordValue>>();
  private readonly prefixes = new Map<string, unknown[]>();
  readonly stats = {
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
