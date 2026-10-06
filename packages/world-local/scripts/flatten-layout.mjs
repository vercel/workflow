// Roll a world-local data directory back to the flat layout that
// @workflow/world-local 5.0.1 and earlier read: every file of
// `events/<runId>/` and `steps/<runId>/` moved directly into `events/` and
// `steps/`, under the same name.
//
//   node scripts/flatten-layout.mjs <dataDir>
//
// Stop every process using the data directory first (dev server, CLI, web
// UI). A file already at the flat path is never overwritten; it is reported
// and its run-scoped copy is left in place.
import fs from 'node:fs/promises';
import path from 'node:path';

const [dataDir] = process.argv.slice(2);
if (!dataDir) {
  console.error('usage: flatten-layout.mjs <dataDir>');
  process.exit(2);
}

let moved = 0;
let skipped = 0;
for (const entityDir of ['events', 'steps']) {
  const root = path.join(dataDir, entityDir);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(root, entry.name);
    for (const name of await fs.readdir(runDir)) {
      const to = path.join(root, name);
      try {
        await fs.lstat(to);
        console.warn(`skipped ${path.join(entityDir, name)}: flat path exists`);
        skipped++;
        continue;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.rename(path.join(runDir, name), to);
      moved++;
    }
    await fs.rmdir(runDir).catch(() => {});
  }
}
console.log(`moved ${moved} files back to the flat layout, skipped ${skipped}`);
