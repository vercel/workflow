/** Experimental JSON conversation log. Values remain ordinary arrays/objects. */
export interface HistoryCursor {
  readonly logId: string;
  readonly end: number;
}
export interface HistorySource {
  readonly sourceId: string;
  readonly path: readonly (string | number)[];
}
export type SharedHistory<T> = T[] & { readonly __sharedHistory?: never };
export type SharedHistoryMark =
  | { kind: 'source'; sourceId: string }
  | ({ kind: 'ref' } & HistorySource)
  | ({ kind: 'prefix' } & HistoryCursor)
  | { kind: 'append'; logId: string; start: number; end: number }
  | { kind: 'projection'; fields: Record<string, HistorySource> };
export const SHARED_HISTORY_MARK = Symbol.for('@workflow/shared-history/v1');

export function historyMark(value: unknown): SharedHistoryMark | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return Object.getOwnPropertyDescriptor(value, SHARED_HISTORY_MARK)?.value;
}
function mark<T extends object>(value: T, descriptor: SharedHistoryMark): T {
  const existing = historyMark(value);
  if (Object.isFrozen(value)) {
    if (
      existing?.kind === 'prefix' &&
      descriptor.kind === 'prefix' &&
      existing.logId === descriptor.logId &&
      existing.end === descriptor.end
    )
      return value;
    throw new Error('Cannot change a frozen shared history value');
  }
  Object.defineProperty(value, SHARED_HISTORY_MARK, {
    value: descriptor,
    configurable: true,
    enumerable: false,
  });
  return value;
}
/**
 * A producer stores its JSON value once. Deserialization retains its origin,
 * allowing later inputs and normalized messages to reference the same bytes.
 * Publication is the existing hook/step event commit, never an earlier write.
 */
function freezeJson(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const key = Symbol.for('@workflow/shared-history/deeply-frozen');
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: WeakSet<object>;
  };
  registry[key] ??= new WeakSet<object>();
  const frozen = registry[key];
  if (frozen.has(value)) return;
  frozen.add(value);
  for (const entry of Object.values(value)) freezeJson(entry);
  Object.freeze(value);
}
export const SharedHistory = {
  enabled(): boolean {
    return typeof process !== 'undefined'
      ? process.env.WORKFLOW_SHARED_HISTORY === '1'
      : (globalThis as Record<string, unknown>)
          .__workflowSharedHistoryEnabled === true;
  },
  source<T extends object>(value: T, sourceId: string): T {
    if (!sourceId || sourceId.length > 256)
      throw new Error('Invalid history source');
    return mark(value, { kind: 'source', sourceId });
  },
  origin(value: unknown, field?: string | number): HistorySource | undefined {
    const m = historyMark(value);
    if (
      field !== undefined &&
      (!value || typeof value !== 'object' || !Object.hasOwn(value, field))
    )
      return undefined;
    if (m?.kind === 'ref')
      return {
        sourceId: m.sourceId,
        path: field === undefined ? m.path : [...m.path, field],
      };
    return field !== undefined && m?.kind === 'projection'
      ? m.fields[field]
      : undefined;
  },
  project<T extends object>(
    value: T,
    fields: Record<string, HistorySource>
  ): T {
    return mark(value, { kind: 'projection', fields });
  },
  prefix<T>(values: T[], cursor: HistoryCursor): SharedHistory<T> {
    if (!Number.isSafeInteger(cursor.end) || cursor.end !== values.length) {
      throw new Error('History cursor must name the exact immutable prefix');
    }
    const result = mark(values, { kind: 'prefix', ...cursor });
    freezeJson(result);
    return result;
  },
  cursor(value: unknown): HistoryCursor | undefined {
    const m = historyMark(value);
    return m?.kind === 'prefix' ? { logId: m.logId, end: m.end } : undefined;
  },
  append<T extends object>(delta: T, cursor: HistoryCursor, end: number): T {
    if (!Number.isSafeInteger(end) || end < cursor.end)
      throw new Error('Invalid history append');
    return mark(delta, {
      kind: 'append',
      logId: cursor.logId,
      start: cursor.end,
      end,
    });
  },
  appendedCursor(value: unknown): HistoryCursor | undefined {
    const m = historyMark(value);
    return m?.kind === 'append' ? { logId: m.logId, end: m.end } : undefined;
  },
};
