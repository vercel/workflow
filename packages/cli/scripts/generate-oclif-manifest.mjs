// Writes oclif.manifest.json into the published package.
//
// Without a manifest, oclif imports every command module on startup to read
// its metadata, so any `workflow` invocation (even `--version`) loads the
// dependencies of every command. With it, oclif reads the metadata from this
// file and imports only the command being run.
//
// Runs from `prepack` (after `build`), and `postpack` removes the file again,
// so a local checkout never holds a manifest that could go stale while the
// commands are edited. `build` also removes it, in case a failed pack left
// one behind.

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Plugin } from '@oclif/core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

await writeFile(
  join(root, 'oclif.manifest.json'),
  `${JSON.stringify(plugin.manifest, null, 2)}\n`
);
