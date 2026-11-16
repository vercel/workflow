import fs from 'node:fs';
import path from 'node:path';

/**
 * What earlier releases stored as JSON files, one per entity. This release
 * stores everything in `world.db` and neither reads nor deletes them.
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
      return fs.statSync(path.join(dataDir, entry)).isDirectory();
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
