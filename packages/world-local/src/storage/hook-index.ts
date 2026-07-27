import fs from 'node:fs/promises';
import path from 'node:path';
import type { Event } from '@workflow/world';
import { EventSchema, HookSchema } from '@workflow/world';
import { z } from 'zod';
import {
  assertSafeEntityId,
  deleteJSON,
  hasTag,
  isUntagged,
  listJSONFiles,
  readJSON,
  resolveWithinBase,
  stripTag,
  taggedPath,
  writeExclusive,
} from '../fs.js';
import { hashToken } from './helpers.js';

/**
 * Durable secondary indexes for hook lookups. Event files are keyed by
 * `{runId}-{eventId}`, so answering "find the live hook_created event
 * for this token/hookId" used to require scanning the entire global
 * event log — O(total history) on every first-time hook creation.
 *
 * Indexes maintained here:
 *   - `hooks/token-index/{sha256(token)}/{eventId}[.tag].json` → `{runId}`
 *   - `hooks/id-index/{hookId}/{eventId}[.tag].json` → `{runId}`
 *   - `hooks/by-run/{runId}-{hookId}[.tag].json` → `{hookId, tag?}`
 *     (per live hook entity, for run-termination cleanup)
 *
 * Crash-ordering invariant: entries are written BEFORE the write they
 * index (event publish / entity write), so a crash can only leave a
 * dangling entry pointing at a write that never landed — readers skip
 * those. A committed event/entity invisible to the index cannot occur.
 *
 * Pre-index data directories are handled by a one-time backfill
 * (`ensureHookIndexes`) guarded by a completion marker.
 */

const IndexEntrySchema = z.object({
  runId: z.string(),
});

const ByRunMarkerSchema = z.object({
  hookId: z.string(),
  tag: z.string().optional(),
});

// No `.json` extension so entity listings never pick it up.
const INDEX_COMPLETE_MARKER = '.hook-index-complete';

function tokenIndexDir(basedir: string, token: string): string {
  return resolveWithinBase(basedir, 'hooks', 'token-index', hashToken(token));
}

function idIndexDir(basedir: string, hookId: string): string {
  assertSafeEntityId('hookId', hookId);
  return resolveWithinBase(basedir, 'hooks', 'id-index', hookId);
}

function byRunDir(basedir: string): string {
  return resolveWithinBase(basedir, 'hooks', 'by-run');
}

function tagOf(fileId: string): string | undefined {
  const stripped = stripTag(fileId);
  return stripped === fileId ? undefined : fileId.slice(stripped.length + 1);
}

/** Same visibility rule as event files: untagged is visible to all. */
export function isVisibleToTag(
  fileId: string,
  tag: string | undefined
): boolean {
  return tag ? isUntagged(fileId) || hasTag(fileId, tag) : isUntagged(fileId);
}

async function readEventLenient(filePath: string): Promise<Event | null> {
  try {
    return await readJSON(filePath, EventSchema);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return null;
    }
    throw error;
  }
}

/**
 * Record a `hook_created` event in the token- and id-indexes. Must be
 * called before the event is published. Idempotent (`writeExclusive`).
 */
export async function writeHookCreatedIndexEntries(
  basedir: string,
  token: string,
  runId: string,
  hookId: string,
  eventId: string,
  tag?: string
): Promise<void> {
  assertSafeEntityId('runId', runId);
  assertSafeEntityId('eventId', eventId);
  if (tag !== undefined) assertSafeEntityId('tag', tag);
  const fileName = tag ? `${eventId}.${tag}.json` : `${eventId}.json`;
  const content = JSON.stringify({ runId });
  await Promise.all([
    writeExclusive(path.join(tokenIndexDir(basedir, token), fileName), content),
    writeExclusive(path.join(idIndexDir(basedir, hookId), fileName), content),
  ]);
}

export function hookByRunMarkerPath(
  basedir: string,
  runId: string,
  hookId: string,
  tag?: string
): string {
  return taggedPath(basedir, 'hooks/by-run', `${runId}-${hookId}`, tag);
}

/**
 * Record a by-run marker for a hook entity. Must be called before the
 * entity write. Idempotent (`writeExclusive`).
 */
export async function writeHookByRunMarker(
  basedir: string,
  runId: string,
  hookId: string,
  tag?: string
): Promise<void> {
  await writeExclusive(
    hookByRunMarkerPath(basedir, runId, hookId, tag),
    JSON.stringify(tag ? { hookId, tag } : { hookId })
  );
}

/**
 * Delete the by-run marker(s) for a hook. A tagged world also removes
 * the untagged variant, since entity reads fall back tagged→untagged.
 */
export async function deleteHookByRunMarker(
  basedir: string,
  runId: string,
  hookId: string,
  tag?: string
): Promise<void> {
  await deleteJSON(hookByRunMarkerPath(basedir, runId, hookId, tag));
  if (tag) {
    await deleteJSON(hookByRunMarkerPath(basedir, runId, hookId));
  }
}

export interface HookByRunMarker {
  /** fileId of the marker (without `.json`), for deletion. */
  fileId: string;
  /** Parsed marker content, or null when the file is unreadable debris. */
  hookId: string | null;
  tag?: string;
}

export async function listHookByRunMarkers(
  basedir: string,
  runId: string
): Promise<HookByRunMarker[]> {
  assertSafeEntityId('runId', runId);
  const dir = byRunDir(basedir);
  const prefix = `${runId}-`;
  const out: HookByRunMarker[] = [];
  for (const fileId of await listJSONFiles(dir)) {
    if (!fileId.startsWith(prefix)) continue;
    let marker: z.infer<typeof ByRunMarkerSchema> | null = null;
    try {
      marker = await readJSON(
        path.join(dir, `${fileId}.json`),
        ByRunMarkerSchema
      );
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) {
        throw error;
      }
    }
    out.push({
      fileId,
      hookId: marker?.hookId ?? null,
      tag: marker?.tag,
    });
  }
  return out;
}

export async function deleteHookByRunMarkerFile(
  basedir: string,
  fileId: string
): Promise<void> {
  await deleteJSON(path.join(byRunDir(basedir), `${fileId}.json`));
}

// Per-process ensure cache; only successful backfills are cached.
const ensuredBasedirs = new Map<string, Promise<void>>();

/** Forget completed backfills (data-dir reset / tests). */
export function resetHookIndexEnsureCache(): void {
  ensuredBasedirs.clear();
}

/**
 * One-time backfill of the indexes for data directories created before
 * they existed — a single full scan, guarded by a completion marker.
 * Concurrent backfills are safe: all writes are idempotent
 * `writeExclusive` calls with byte-identical content.
 */
export async function ensureHookIndexes(basedir: string): Promise<void> {
  const key = path.resolve(basedir);
  let pending = ensuredBasedirs.get(key);
  if (!pending) {
    pending = ensureHookIndexesImpl(key).catch((error) => {
      ensuredBasedirs.delete(key);
      throw error;
    });
    ensuredBasedirs.set(key, pending);
  }
  return pending;
}

async function forEachConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let start = 0; start < items.length; start += concurrency) {
    await Promise.all(items.slice(start, start + concurrency).map(fn));
  }
}

async function ensureHookIndexesImpl(basedir: string): Promise<void> {
  const markerPath = path.join(basedir, 'hooks', INDEX_COMPLETE_MARKER);
  try {
    await fs.access(markerPath);
    return;
  } catch {
    // Marker absent — backfill below.
  }

  const eventsDir = path.join(basedir, 'events');
  await forEachConcurrent(
    await listJSONFiles(eventsDir),
    32,
    async (fileId) => {
      const event = await readEventLenient(
        path.join(eventsDir, `${fileId}.json`)
      );
      if (!event || event.eventType !== 'hook_created') return;
      if (typeof event.correlationId !== 'string') return;
      const token = (event.eventData as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string') return;
      try {
        await writeHookCreatedIndexEntries(
          basedir,
          token,
          event.runId,
          event.correlationId,
          event.eventId,
          tagOf(fileId)
        );
      } catch {
        // Unsafe ids cannot have been written by this storage layer; skip.
      }
    }
  );

  const hooksDir = path.join(basedir, 'hooks');
  await forEachConcurrent(await listJSONFiles(hooksDir), 32, async (fileId) => {
    let hook: z.infer<typeof HookSchema> | null = null;
    try {
      hook = await readJSON(path.join(hooksDir, `${fileId}.json`), HookSchema);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) {
        throw error;
      }
    }
    if (!hook) return;
    try {
      await writeHookByRunMarker(
        basedir,
        hook.runId,
        hook.hookId,
        tagOf(fileId)
      );
    } catch {
      // Unsafe ids cannot have been written by this storage layer; skip.
    }
  });

  await writeExclusive(markerPath, '');
}

/**
 * Find the newest visible `hook_created` event for a token or hookId.
 * Entries are iterated newest-first (eventIds are ULIDs); dangling or
 * non-matching entries are skipped. Liveness is the caller's job.
 */
export async function findNewestIndexedHookCreatedEvent(
  basedir: string,
  index: { kind: 'token'; token: string } | { kind: 'id'; hookId: string },
  matches: (event: Event) => boolean,
  tag?: string
): Promise<Event | null> {
  await ensureHookIndexes(basedir);
  let dir: string;
  try {
    dir =
      index.kind === 'token'
        ? tokenIndexDir(basedir, index.token)
        : idIndexDir(basedir, index.hookId);
  } catch {
    return null;
  }

  const entryIds = (await listJSONFiles(dir))
    .filter((fileId) => isVisibleToTag(fileId, tag))
    .sort((a, b) => stripTag(b).localeCompare(stripTag(a)));

  for (const entryId of entryIds) {
    let entry: z.infer<typeof IndexEntrySchema> | null = null;
    try {
      entry = await readJSON(
        path.join(dir, `${entryId}.json`),
        IndexEntrySchema
      );
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) {
        throw error;
      }
    }
    if (!entry) continue;

    const eventId = stripTag(entryId);
    let eventPath: string;
    try {
      eventPath = taggedPath(
        basedir,
        'events',
        `${entry.runId}-${eventId}`,
        tagOf(entryId)
      );
    } catch {
      continue;
    }
    const event = await readEventLenient(eventPath);
    if (!event) continue;
    if (event.eventType !== 'hook_created') continue;
    if (typeof event.correlationId !== 'string') continue;
    if (!matches(event)) continue;
    return event;
  }
  return null;
}
