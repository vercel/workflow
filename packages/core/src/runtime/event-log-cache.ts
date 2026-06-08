import type { Event } from '@workflow/world';
import {
  getEventCacheMaxBytes,
  getEventCacheMaxEntries,
  isEventCacheEnabled,
} from './constants.js';

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

  /**
   * The returned event array is cache-owned and must not be mutated. Copy it
   * before appending or otherwise changing the replay prefix.
   */
  get(runId: string): CachedEventLog | undefined {
    if (!isEventCacheEnabled()) {
      this.clear();
      return undefined;
    }

    const entry = this.entries.get(runId);
    if (!entry) return undefined;

    this.entries.delete(runId);
    this.entries.set(runId, entry);
    return { cursor: entry.cursor, events: entry.events };
  }

  set(runId: string, events: readonly Event[], cursor: string | null): void {
    if (!isEventCacheEnabled()) {
      this.clear();
      return;
    }

    const maxCacheBytes = getEventCacheMaxBytes();
    const maxCacheEntries = getEventCacheMaxEntries();
    const existing = this.entries.get(runId);
    if (existing && existing.events.length > events.length) {
      this.entries.delete(runId);
      this.entries.set(runId, existing);
      return;
    }

    this.delete(runId);
    if (!cursor || events.length === 0) return;

    const bytes = estimateSizeUpTo(events, maxCacheBytes);
    if (bytes > maxCacheBytes) return;

    while (
      this.entries.size >= maxCacheEntries ||
      this.retainedBytes + bytes > maxCacheBytes
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

function estimateSizeUpTo(value: unknown, limit: number): number {
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
      for (const entry of item) {
        if (total > limit) return;
        visit(entry);
      }
      return;
    }

    for (const [key, entry] of Object.entries(item)) {
      if (total > limit) return;
      if (!add(key.length * 2 + 8)) return;
      visit(entry);
    }
  };

  visit(value);
  return total;
}
