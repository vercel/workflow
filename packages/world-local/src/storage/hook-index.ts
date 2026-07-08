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
 * Durable secondary indexes for hook lifecycle lookups.
 *
 * The event log stores one file per event in a single flat `events/`
 * directory, keyed by `{runId}-{eventId}`. Hook lookups, however, are
 * keyed by *token* or by *hookId* — neither of which appears in the
 * filename — so historically any "find the live hook_created event"
 * question (crash recovery, cache rebuilds, token-uniqueness checks)
 * was answered by reading and parsing EVERY event file ever written
 * across ALL runs. Since events are append-only and never deleted,
 * that scan grew linearly with the total history of the data
 * directory and made hook creation (and webhook token resolution)
 * slower over time (see the sequential-turns stress regression).
 *
 * This module maintains three small filesystem indexes instead:
 *
 *   - `hooks/token-index/{sha256(token)}/{eventId}[.tag].json`
 *     → `{ runId }` — every persisted `hook_created` event, keyed by
 *     token hash. Lets the rebuild path locate all candidate events
 *     for a token without touching the global log.
 *
 *   - `hooks/id-index/{hookId}/{eventId}[.tag].json`
 *     → `{ runId }` — the same events keyed by hookId, for
 *     `hooks.get` cache rebuilds.
 *
 *   - `hooks/by-run/{runId}-{hookId}[.tag].json`
 *     → `{ hookId, tag? }` — one marker per live hook entity, so
 *     run-termination cleanup can find a run's hooks with a prefix
 *     readdir instead of reading every live hook entity in the world.
 *
 * Index entries are written BEFORE the writes they index (the
 * `hook_created` event publish / the hook entity write), so a crash
 * can only ever leave a dangling index entry pointing at a write
 * that never happened — readers tolerate that by skipping entries
 * whose target is missing. The inverse (a committed event/entity
 * with no index entry) cannot occur for post-upgrade writes, which
 * is what makes it safe for readers to trust the index instead of
 * scanning the log.
 *
 * Entries are append-only (like the events they mirror) except for
 * `by-run` markers, which are deleted together with their hook
 * entity. Stale `token-index` / `id-index` entries are filtered at
 * read time by the same liveness checks the full scan used (owning
 * run terminal, disposal committed), so leaving them behind is
 * harmless.
 *
 * Data directories created by older versions of this package contain
 * events/hooks with no index entries. `ensureHookIndexes` performs a
 * one-time backfill (a single full scan — the same cost as ONE
 * pre-index rebuild) and then publishes a completion marker so the
 * scan never runs again.
 */

const IndexEntrySchema = z.object({
  runId: z.string(),
});

const ByRunMarkerSchema = z.object({
  hookId: z.string(),
  tag: z.string().optional(),
});

/**
 * Completion marker for the one-time legacy backfill. Lives directly
 * in `hooks/` but has no `.json` extension so entity listings
 * (`listJSONFiles`) never pick it up.
 */
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

/**
 * Extract the tag suffix from a fileId, or undefined when untagged.
 * `evnt_ABC.vitest-0` → `vitest-0`; `evnt_ABC` → undefined.
 */
function tagOf(fileId: string): string | undefined {
  const stripped = stripTag(fileId);
  return stripped === fileId ? undefined : fileId.slice(stripped.length + 1);
}

/**
 * Mirror of the event-visibility rule used for event files: an
 * untagged entry is visible to every world, a tagged entry only to
 * its own tag, and an untagged world sees only untagged entries.
 */
export function isVisibleToTag(
  fileId: string,
  tag: string | undefined
): boolean {
  return tag ? isUntagged(fileId) || hasTag(fileId, tag) : isUntagged(fileId);
}

/**
 * Read an event file, tolerating malformed JSON / schema mismatches
 * (returns null) the same way the historical full-log scan did.
 */
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
 * Record a `hook_created` event in the token- and id-indexes. MUST be
 * called before the event itself is published (see module comment for
 * the crash-ordering rationale). Idempotent: `writeExclusive` no-ops
 * when the entry already exists (e.g. cross-process dedup-recovery
 * retries converging on the same canonical eventId).
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

/** Path of the by-run marker for a hook entity. */
export function hookByRunMarkerPath(
  basedir: string,
  runId: string,
  hookId: string,
  tag?: string
): string {
  return taggedPath(basedir, 'hooks/by-run', `${runId}-${hookId}`, tag);
}

/**
 * Record a by-run marker for a hook entity. MUST be called before the
 * entity write it indexes (a dangling marker is skipped by cleanup; a
 * marker-less entity would never be cleaned on run termination).
 * Idempotent via `writeExclusive`.
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
 * the untagged variant because the hook entity it just disposed may
 * have been created by an untagged world (entity reads fall back from
 * tagged to untagged paths).
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

/**
 * List the by-run markers for a run. O(hooks of this run) after the
 * prefix filter; unreadable markers are surfaced with `hookId: null`
 * so callers can delete the debris.
 */
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

/** Delete a by-run marker by its raw fileId (as returned by list). */
export async function deleteHookByRunMarkerFile(
  basedir: string,
  fileId: string
): Promise<void> {
  await deleteJSON(path.join(byRunDir(basedir), `${fileId}.json`));
}

// Per-process ensure cache. Keyed by resolved basedir; holds the
// in-flight/completed backfill promise so concurrent callers share
// one backfill. Only successful completion is cached.
const ensuredBasedirs = new Map<string, Promise<void>>();

/**
 * Forget completed backfills. Called by `clear()` (the data directory
 * is being reset underneath us) and by tests simulating legacy
 * pre-index data directories.
 */
export function resetHookIndexEnsureCache(): void {
  ensuredBasedirs.clear();
}

/**
 * Ensure the hook indexes exist for a data directory, performing the
 * one-time legacy backfill when the completion marker is absent.
 *
 * The backfill scans the global event log once (the same cost as a
 * single pre-index rebuild) to index every persisted `hook_created`
 * event, plus the live hook entities to create by-run markers, then
 * publishes the completion marker. Fresh data directories pay only a
 * readdir of two empty directories. Concurrent backfills (multiple
 * processes) are safe: all writes are idempotent `writeExclusive`
 * calls with byte-identical content.
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

async function ensureHookIndexesImpl(basedir: string): Promise<void> {
  const markerPath = path.join(basedir, 'hooks', INDEX_COMPLETE_MARKER);
  try {
    await fs.access(markerPath);
    return;
  } catch {
    // Marker absent — run the backfill below.
  }

  // Backfill 1: token/id index entries from every persisted
  // hook_created event (any tag; entries inherit the source event
  // file's tag so read-time visibility matches event visibility).
  const eventsDir = path.join(basedir, 'events');
  for (const fileId of await listJSONFiles(eventsDir)) {
    const event = await readEventLenient(
      path.join(eventsDir, `${fileId}.json`)
    );
    if (!event || event.eventType !== 'hook_created') continue;
    if (typeof event.correlationId !== 'string') continue;
    const token = (event.eventData as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string') continue;
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
      // Skip events whose ids cannot form safe filenames — they could
      // not have been written by this storage layer in the first place.
    }
  }

  // Backfill 2: by-run markers for the live hook entities.
  const hooksDir = path.join(basedir, 'hooks');
  for (const fileId of await listJSONFiles(hooksDir)) {
    let hook: z.infer<typeof HookSchema> | null = null;
    try {
      hook = await readJSON(path.join(hooksDir, `${fileId}.json`), HookSchema);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) {
        throw error;
      }
    }
    if (!hook) continue;
    try {
      await writeHookByRunMarker(
        basedir,
        hook.runId,
        hook.hookId,
        tagOf(fileId)
      );
    } catch {
      // Same rationale as above: unsafe ids cannot originate from us.
    }
  }

  await writeExclusive(markerPath, '');
}

/**
 * Find the newest visible `hook_created` event for a token or hookId
 * using the durable indexes — the replacement for the historical
 * full-log scan. Entries are iterated newest-first (eventIds are
 * ULIDs, so lexicographic order is creation order); entries whose
 * target event is missing (a crash between the index write and the
 * event publish) or no longer matches are skipped.
 *
 * Liveness (owning run not terminal, disposal not committed) is NOT
 * checked here — callers apply the same final checks the full scan
 * applied. The full scan additionally replayed in-log closure events
 * (`hook_disposed`, terminal run events), but both are strictly
 * implied by those final checks: the dispose lock is durably written
 * BEFORE the `hook_disposed` event is appended (and never deleted),
 * and the run entity is durably terminal BEFORE any terminal run
 * event is appended (and never deleted). So "closed in the log"
 * always implies "closed per the final checks".
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
    // Unsafe hookId can never have been indexed (nor written at all).
    return null;
  }

  const entryIds = (await listJSONFiles(dir))
    .filter((fileId) => isVisibleToTag(fileId, tag))
    // Newest first: strip the tag, compare eventId ULIDs.
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
    if (!event) continue; // Dangling entry: the indexed publish never landed.
    if (event.eventType !== 'hook_created') continue;
    if (typeof event.correlationId !== 'string') continue;
    if (!matches(event)) continue;
    return event;
  }
  return null;
}
