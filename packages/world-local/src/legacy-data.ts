import fs from 'node:fs';
import { readdir, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * What earlier releases stored as JSON files, one per entity. This release
 * stores everything in `world.db` and does not read them; only `clear()`
 * deletes them (see `removeLegacyData`).
 */
const LEGACY_ENTRIES = [
  'runs',
  'events',
  'steps',
  'hooks',
  'waits',
  'streams',
  'snapshots',
  '.locks',
];

/** The JSON data directories of earlier releases present in `dataDir`. */
export function legacyEntriesIn(dataDir: string): string[] {
  return LEGACY_ENTRIES.filter((entry) => {
    try {
      // The data directory is not part of the app: without the ignore
      // comments, every Turbopack build warns that this dynamic path traces
      // the whole project.
      return fs
        .statSync(
          /* turbopackIgnore: true */ path.join(
            /* turbopackIgnore: true */ dataDir,
            entry
          )
        )
        .isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Says, once, that the runs of an earlier release are no longer read: called
 * when `world.db` is created in a data directory that still holds their
 * JSON files, which is the first write after the upgrade, whatever does it
 * (an app, the CLI, a script). Without it, earlier runs would silently be
 * gone from the CLI and the web UI.
 */
export function noticeLegacyData(dataDir: string): void {
  const legacy = legacyEntriesIn(dataDir);
  if (legacy.length === 0) return;
  const dir = path.resolve(dataDir);
  console.info(
    `[world-local] Runs recorded by an earlier version of @workflow/world-local are no longer read (this version keeps its data in ${path.join(dir, 'world.db')}), so the CLI and the web UI do not list them. ` +
      `Their files are still in ${legacy.map((entry) => path.join(dir, entry)).join(', ')}, and can be deleted.`
  );
}

/**
 * Deletes the run data of earlier releases, as their `clear()` did: all of
 * it, or for a tag only the files of that tag (`<id>.<tag>.json` and
 * `<id>.<tag>.bin`), and the directories that leaves empty. Without it a
 * cleared data directory would keep the payloads recorded before the
 * upgrade. A failure rejects: the data directory was not cleared.
 */
export async function removeLegacyData(
  dataDir: string,
  tag?: string
): Promise<void> {
  const entries = legacyEntriesIn(dataDir).map((entry) =>
    path.join(/* turbopackIgnore: true */ dataDir, entry)
  );
  if (tag === undefined) {
    // Not following symbolic links: only what is in the data directory goes.
    await Promise.all(
      entries.map((dir) => rm(dir, { recursive: true, force: true }))
    );
    return;
  }
  const suffixes = [`.${tag}.json`, `.${tag}.bin`];
  // Workers clearing other tags walk the same directories at the same time:
  // what one of them already removed is not an error.
  const gone = (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT';
  const removeDir = (dir: string) =>
    rmdir(dir).catch((error: unknown) => {
      // Not empty: another tag's file, or one written meanwhile, keeps it.
      if (gone(error) || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY')
        return;
      throw error;
    });
  /** Deletes the tag's files under `dir`; whether it is now empty. */
  const removeTagged = async (dir: string): Promise<boolean> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (gone(error)) return false;
      throw error;
    }
    let left = 0;
    for (const entry of entries) {
      const at = path.join(/* turbopackIgnore: true */ dir, entry.name);
      if (entry.isDirectory()) {
        if (await removeTagged(at)) await removeDir(at);
        else left++;
      } else if (
        entry.isFile() &&
        suffixes.some((suffix) => entry.name.endsWith(suffix))
      ) {
        await unlink(at).catch((error: unknown) => {
          if (!gone(error)) throw error;
        });
      } else {
        left++;
      }
    }
    return left === 0;
  };
  for (const dir of entries) {
    if (await removeTagged(dir)) await removeDir(dir);
  }
}
