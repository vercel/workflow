import path from 'node:path';
import type { Event, WorkflowRun } from '@workflow/world';
import {
  EventSchema,
  getEventDataRefFields,
  RETENTION_ATTRIBUTE,
  readRunRetention,
} from '@workflow/world';
import { z } from 'zod';
import { listJSONFiles, readJSON, taggedPath, writeJSON } from '../fs.js';
import { purgeRunStreamData } from '../streamer.js';
import { ensureHookIndexes, listHookByRunMarkers } from './hook-index.js';

/**
 * Whether a finished run asked for its user data to be deleted now.
 *
 * The decision itself is `@workflow/world`'s {@link readRunRetention}, shared
 * with every other World that implements retention — two independently
 * written parsers can drift, and drift here means one World deleting a run
 * another keeps.
 *
 * What this World adds is the warning. An unrecognized value is a rollout
 * problem (an SDK speaking a dialect this version predates), and a dev
 * server's output is where a developer can still notice it.
 */
export function purgesUserDataOnFinish(
  attributes: Record<string, string> | undefined
): boolean {
  const retention = readRunRetention(attributes);
  if (retention.unsupported) {
    console.warn(
      `[world-local] Ignoring unrecognized ${RETENTION_ATTRIBUTE} value ` +
        `${JSON.stringify(retention.raw)}; keeping the run's data.`
    );
  }
  return retention.mode === 'none';
}

/**
 * The run's half of a zero-retention purge: its own payloads dropped and the
 * retention boundary moved onto it, as one value the caller writes in one
 * atomic file replace.
 *
 * Both halves ride the same write on purpose. `expiredAt` is the marker the
 * CLI and the web UI gate their `<data expired>` rendering on, so it is what
 * makes the deletion legible rather than silent — a reader that finds an
 * absent `output` and no boundary cannot tell "purged" from "never had one".
 * Landing them together means no reader can see one without the other.
 */
export function withRunPayloadsPurged<T extends WorkflowRun>(
  run: T,
  purgedAt: Date
): T {
  return {
    ...run,
    input: undefined,
    output: undefined,
    error: undefined,
    expiredAt: purgedAt,
  };
}

/**
 * Delete the user payloads a finished zero-retention run left outside its own
 * row: its steps' input/output/error, its events' payloads, the metadata on
 * any hook that outlived it, and its streams' contents.
 *
 * Call this only *after* the run's own boundary write (see
 * {@link withRunPayloadsPurged}) has landed, and after the terminal event has
 * been published — that event carries the run's output, so purging before it
 * is in the log would leave behind the one copy that matters.
 *
 * **The entities themselves are kept.** Only user data goes, so a purged run
 * stays listable and its history stays walkable, which is the contract the
 * Vercel World holds to as well.
 *
 * Every step is idempotent and independently fallible: a file that cannot be
 * scrubbed is logged and skipped rather than thrown. This runs after the run
 * is already terminal and nothing will retry it, so one unreadable file must
 * not stop the rest of the purge — and must never fail the run itself.
 */
export async function purgeRunEntityData(
  basedir: string,
  runId: string,
  tag: string | undefined
): Promise<void> {
  await Promise.all([
    scrubEntityFiles(path.join(basedir, 'steps'), runId, (step) => {
      step.input = undefined;
      step.output = undefined;
      step.error = undefined;
    }),
    scrubEntityFiles(path.join(basedir, 'events'), runId, (event) => {
      const eventData = event.eventData;
      if (!eventData || typeof eventData !== 'object') return;
      for (const field of getEventDataRefFields(String(event.eventType))) {
        delete (eventData as Record<string, unknown>)[field];
      }
    }),
    scrubHookMetadata(basedir, runId),
    purgeRunStreamData(basedir, runId, tag),
  ]);
}

/**
 * The file exactly as it was written.
 *
 * Deliberately not the entity's own Zod schema: a schema round-trip strips
 * every key the schema does not declare, and a purge has no business
 * rewriting anything but the payload keys it was asked to remove.
 */
const RawEntitySchema = z.record(z.string(), z.any());

/**
 * `EventSchema`, tolerant of a zero-retention purge having deleted an
 * event's ref field (`eventData.input`/`result`/`error`/`payload`, see
 * {@link getEventDataRefFields}) outright.
 *
 * `scrubEntityFiles` above deletes the key rather than writing it back as an
 * explicit `undefined`, because JSON has no way to represent "present but
 * undefined" and a schema round-trip would drop it either way. A *missing*
 * key and a key *present with value `undefined`* are different things to
 * Zod, though: a required field whose own schema tolerates `undefined`
 * (`SerializedDataSchema`'s trailing `z.any()`) only accepts the latter.
 * Every read of a stored event goes through this schema instead of the bare
 * `EventSchema` so a purged run's log stays parseable, while `EventSchema`
 * itself stays strict for the create-time contract (`CreateEventSchema`
 * shares the same per-type schemas, and a run genuinely being created must
 * still supply `input`).
 */
export const ReadEventSchema: z.ZodType<Event> = z.preprocess((raw) => {
  if (
    raw &&
    typeof raw === 'object' &&
    'eventType' in raw &&
    'eventData' in raw
  ) {
    const eventData = (raw as { eventData: unknown }).eventData;
    if (eventData && typeof eventData === 'object') {
      for (const field of getEventDataRefFields(
        String((raw as { eventType: unknown }).eventType)
      )) {
        if (!(field in eventData)) {
          (eventData as Record<string, unknown>)[field] = undefined;
        }
      }
    }
  }
  return raw;
}, EventSchema);

/** Rewrite every file in `directory` belonging to `runId` with `scrub` applied. */
async function scrubEntityFiles(
  directory: string,
  runId: string,
  scrub: (raw: Record<string, any>) => void
): Promise<void> {
  let fileIds: string[];
  try {
    fileIds = await listJSONFiles(directory);
  } catch (error) {
    logPurgeFailure(directory, error);
    return;
  }
  for (const fileId of fileIds) {
    // Tags are ignored when matching, the way terminal wait cleanup already
    // does it: a tag says which World instance wrote the file, not whose data
    // it holds, and every file under this run's id holds this run's data.
    if (!fileId.startsWith(`${runId}-`)) continue;
    const filePath = path.join(directory, `${fileId}.json`);
    try {
      const raw = await readJSON(filePath, RawEntitySchema);
      if (!raw) continue;
      scrub(raw);
      await writeJSON(filePath, raw, { overwrite: true });
    } catch (error) {
      logPurgeFailure(filePath, error);
    }
  }
}

/**
 * Drop the metadata from any hook still standing after terminal cleanup.
 *
 * Most of a run's hooks are deleted outright when it finishes, but one whose
 * `tokenRetentionUntil` has not elapsed is deliberately kept so its token
 * stays reserved. Keeping the reservation does not mean keeping the payload,
 * so the entity stays and its metadata goes.
 */
async function scrubHookMetadata(
  basedir: string,
  runId: string
): Promise<void> {
  let markers: Awaited<ReturnType<typeof listHookByRunMarkers>>;
  try {
    await ensureHookIndexes(basedir);
    markers = await listHookByRunMarkers(basedir, runId);
  } catch (error) {
    logPurgeFailure(`hooks of ${runId}`, error);
    return;
  }
  for (const marker of markers) {
    // A marker whose body could not be read names no hook to scrub. Terminal
    // cleanup leaves those alone too; deleting one here would be the purge
    // guessing at data it cannot see.
    if (!marker.hookId) continue;
    try {
      const hookPath = taggedPath(basedir, 'hooks', marker.hookId, marker.tag);
      const hook = await readJSON(hookPath, RawEntitySchema);
      if (!hook || hook.runId !== runId) continue;
      hook.metadata = undefined;
      await writeJSON(hookPath, hook, { overwrite: true });
    } catch (error) {
      logPurgeFailure(marker.hookId, error);
    }
  }
}

function logPurgeFailure(target: string, error: unknown): void {
  console.warn(
    `[world-local] Failed to purge user data for ${target}:`,
    error instanceof Error ? error.message : error
  );
}
