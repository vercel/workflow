// Writes oclif.manifest.json into the published package.
//
// Without a manifest, oclif imports every command module on startup to read
// its metadata, so any `workflow` invocation (even `--version`) loads the
// dependencies of every command. With it, oclif reads the metadata from this
// file and imports only the command being run.
//
// Runs from `prepack` (after `build`), and `postpack` removes the file again,
// so a local checkout never holds a manifest that could go stale while the
// commands are edited. `build` and `dev` also remove it, in case a failed
// pack left one behind, but `build` does not run on a turbo cache hit. oclif
// accepts a leftover manifest without a warning for every prerelease of the
// same version, so to try the manifest locally use `pnpm pack`, or pass an
// output directory: `node scripts/generate-oclif-manifest.mjs <dir>`.

import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Plugin, settings } from '@oclif/core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ? resolve(process.argv[2]) : root;

// With NODE_ENV=development or test, oclif maps `dist` to `src` when it can
// find tsx or ts-node, and the manifest would point every command at
// `src/commands/*.ts`, which is not published. Always record `dist`.
settings.enableAutoTranspile = false;

const plugin = new Plugin({
  root,
  type: 'core',
  ignoreManifest: true,
  errorOnManifestCreate: true,
  respectNoCacheDefault: true,
});
await plugin.load();

// An empty manifest would hide every command, so refuse to write one (for
// example when `dist` has not been built yet).
if (Object.keys(plugin.manifest.commands).length === 0) {
  throw new Error(
    'No commands found in dist/commands. Run `pnpm build` before packing.'
  );
}

for (const [id, command] of Object.entries(plugin.manifest.commands)) {
  if (command.relativePath?.[0] !== 'dist') {
    throw new Error(
      `Command "${id}" resolved to ${command.relativePath?.join('/')}, expected a file in dist/commands.`
    );
  }
}

await writeFile(
  join(outDir, 'oclif.manifest.json'),
  `${JSON.stringify(plugin.manifest, null, 2)}\n`
);
