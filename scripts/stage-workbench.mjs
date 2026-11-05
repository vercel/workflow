/**
 * Stage a workbench outside the monorepo, installed the way a user's app is:
 * the Workflow packages as published (only what each package's `files` ships),
 * every other dependency at the version `pnpm-lock.yaml` locks. Next.js treats
 * workspace-linked packages differently from installed ones, so the Next.js
 * e2e lanes test the staged copy.
 *
 * `pnpm deploy` does the install. The rest is what it leaves out: the
 * workbenches share files through symlinks into sibling directories, which
 * `deploy` drops, they import from `workbench/scripts` and the repo's `lib`
 * (`@repo/lib`), which sit outside the package, and `deploy` packs the
 * project by npm's rules, which leave out `.gitignore`: the Next.js dev
 * watcher reads it, as it would in a user's app.
 *
 * Usage: node scripts/stage-workbench.mjs workbench/<name>
 * Prints `Staged workbench: <path>` last.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

/** Directories no workbench file is staged from. */
const SKIPPED = new Set(['node_modules', '.next', '.turbo', '.vercel']);

/**
 * Copy what every symlink under `sourceDir` points at to the same place under
 * `destinationDir`, so the staged copy holds real files.
 */
export function copySymlinkTargets(sourceDir, destinationDir) {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isSymbolicLink()) {
      fs.rmSync(destination, { recursive: true, force: true });
      fs.cpSync(source, destination, { recursive: true, dereference: true });
    } else if (entry.isDirectory()) {
      copySymlinkTargets(source, destination);
    }
  }
}

function main() {
  const workbench = process.argv[2];
  if (!workbench) {
    console.error('Usage: node scripts/stage-workbench.mjs workbench/<name>');
    process.exit(1);
  }
  const sourceDir = path.resolve(repoRoot, workbench);
  const name = path.basename(sourceDir);
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `workflow-${name}-`));
  const stagedDir = path.join(stageRoot, 'workbench', name);

  const pnpm = (...args) =>
    execFileSync('pnpm', args, { cwd: repoRoot, stdio: 'inherit' });
  // `deploy` copies each Workflow package's `files` as they are on disk, but
  // a published package also carries what its `prepack` generates (bundled
  // docs, the CLI's oclif manifest). Run the hooks around it, as `pnpm pack`
  // does.
  pnpm('--filter', './packages/*', 'run', '--if-present', 'prepack');
  try {
    pnpm(
      '--filter',
      `./${path.relative(repoRoot, sourceDir)}`,
      'deploy',
      stagedDir
    );
  } finally {
    pnpm('--filter', './packages/*', 'run', '--if-present', 'postpack');
  }
  copySymlinkTargets(sourceDir, stagedDir);
  const gitignore = path.join(sourceDir, '.gitignore');
  if (fs.existsSync(gitignore)) {
    fs.copyFileSync(gitignore, path.join(stagedDir, '.gitignore'));
  }
  for (const shared of ['workbench/scripts', 'lib']) {
    fs.cpSync(path.join(repoRoot, shared), path.join(stageRoot, shared), {
      recursive: true,
      dereference: true,
    });
  }

  console.log(`Staged workbench: ${stagedDir}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
