import type { Event } from '@workflow/world';

const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_RUNS = 64;
const MAX_RUN_BYTES = 512 * 1024;

export interface CachedEventLog {
  cursor: string;
  events: readonly Event[];
}

interface CacheEntry extends CachedEventLog {
  bytes: number;
}

/**
 * A small LRU for replay prefixes. The retained prefix is never considered
 * current by itself: callers must read after its cursor before replaying.
 */
export class EventLogCache {
  private readonly entries = new Map<string, CacheEntry>();
  private retainedBytes = 0;

  get(runId: string): CachedEventLog | undefined {
    const entry = this.entries.get(runId);
    if (!entry) return undefined;

    this.entries.delete(runId);
    this.entries.set(runId, entry);
    return { cursor: entry.cursor, events: entry.events };
  }

  set(runId: string, events: readonly Event[], cursor: string | null): void {
    const existing = this.entries.get(runId);
    if (existing && existing.events.length > events.length) {
      this.entries.delete(runId);
      this.entries.set(runId, existing);
      return;
    }

    this.delete(runId);
    if (!cursor || events.length === 0) return;

    const bytes = estimateSize(events, MAX_RUN_BYTES);
    if (bytes > MAX_RUN_BYTES || bytes > MAX_CACHE_BYTES) return;

    while (
      this.entries.size >= MAX_CACHE_RUNS ||
      this.retainedBytes + bytes > MAX_CACHE_BYTES
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }

    this.entries.set(runId, {
      cursor,
      events: [...events],
      bytes,
    });
    this.retainedBytes += bytes;
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }

  private delete(runId: string): void {
    const existing = this.entries.get(runId);
    if (!existing) return;
    this.entries.delete(runId);
    this.retainedBytes -= existing.bytes;
  }
}

function estimateSize(value: unknown, limit: number): number {
  const seen = new WeakSet<object>();
  let total = 0;

  const add = (bytes: number) => {
    total += bytes;
    return total <= limit;
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: retained-byte estimation must classify serialized payload value types.
  const visit = (item: unknown): void => {
    if (total > limit || item === null || item === undefined) return;

    switch (typeof item) {
      case 'boolean':
        add(4);
        return;
      case 'number':
      case 'bigint':
        add(8);
        return;
      case 'string':
        add(item.length * 2 + 8);
        return;
      case 'object':
        break;
      default:
        return;
    }

    if (item instanceof Date) {
      add(16);
      return;
    }
    if (ArrayBuffer.isView(item)) {
      add(item.byteLength + 32);
      return;
    }
    if (item instanceof ArrayBuffer) {
      add(item.byteLength + 32);
      return;
    }
    if (seen.has(item)) return;
    seen.add(item);
    if (!add(32)) return;

    if (Array.isArray(item)) {
      for (const entry of item) visit(entry);
      return;
    }

    for (const [key, entry] of Object.entries(item)) {
      if (!add(key.length * 2 + 8)) return;
      visit(entry);
    }
  };

  visit(value);
  return total;
}
