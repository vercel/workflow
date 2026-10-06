import fs from 'node:fs/promises';
import path from 'node:path';
import { globalSingleton } from '@workflow/utils';
import { z } from 'zod';
import {
  RUN_SCOPED_ENTITY_DIRS,
  type RunScopedEntityDir,
  readJSON,
  runEntityDir,
  withWindowsRetry,
} from '../fs.js';

/**
 * Data directories written before run-scoped storage kept every event and
 * step file directly in `events/` and `steps/`. Each per-run read then had to
 * list the whole directory, so its cost grew with every run the directory had
 * ever held. This module moves those flat files into their run's
 * subdirectory (`events/<runId>/`, `steps/<runId>/`) under their existing
 * names.
 *
 * The move runs once per data directory per process, before the first storage
 * call. It is cheap to repeat: once a directory has been converted, a pass is
 * one `readdir` of `events/` and of `steps/`, which by then hold one entry
 * per run. Repeating it is what makes the conversion safe to interrupt, and
 * lets it pick up files an older version of this package wrote to the flat
 * layout after an earlier pass.
 *
 * A file already at the destination is never overwritten: if it is the same
 * inode (hard-linked at both paths) the flat name is dropped, otherwise the
 * flat file is left in place and reported as skipped.
 *
 * Stop every process running an older version of this package on the data
 * directory before upgrading. The pass runs once per process, so a flat file
 * an older writer adds afterwards stays invisible to this process (its run
 * looks truncated) until the next process start moves it. There is no
 * automatic downgrade: older versions only read the flat layout, so rolling
 * back means moving each `events/<runId>/` and `steps/<runId>/` file back up
 * one level, under the same name, with every process stopped.
 */

/** Per-entity id prefix of the second half of a file id, `${runId}-${id}`. */
const ENTITY_ID_PREFIX: Record<RunScopedEntityDir, string> = {
  events: '-evnt_',
  steps: '-step_',
};

const RunIdSchema = z.object({ runId: z.string() });

export interface FlatLayoutMigrationResult {
  /** Files moved into their run's subdirectory. */
  moved: number;
  /** Flat files left in place: unparseable, or a different file was already at the destination. */
  skipped: number;
}

/**
 * The run a flat file belongs to. Its name is `${runId}-${entityId}` plus an
 * optional `.${tag}` and the `.json` extension, but both halves may contain
 * `-` (custom run ids, and step ids such as `step_a-step_b`), so the name
 * alone is only conclusive when the `-evnt_` / `-step_` separator occurs
 * exactly once. Otherwise the run id stored in the file decides, provided the
 * name really starts with it; anything else is left in place.
 */
async function runIdOfFlatFile(
  entityDir: RunScopedEntityDir,
  filePath: string
): Promise<string | null> {
  const name = path.basename(filePath);
  const separator = ENTITY_ID_PREFIX[entityDir];
  const first = name.indexOf(separator);
  if (first > 0 && name.indexOf(separator, first + 1) === -1) {
    return name.slice(0, first);
  }
  let stored: string | undefined;
  try {
    stored = (await readJSON(filePath, RunIdSchema))?.runId;
  } catch {
    return null;
  }
  if (!stored || !name.startsWith(`${stored}-`)) return null;
  return stored;
}

/**
 * How the flat file `from` relates to the file already at `to`: the same
 * inode (hard-linked at both paths), already gone from the flat directory
 * (a concurrent pass finished the move), or a different file.
 */
async function compareWithDestination(
  from: string,
  to: string
): Promise<'same' | 'gone' | 'different'> {
  let sa: import('node:fs').Stats;
  try {
    sa = await fs.stat(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw error;
  }
  const sb = await fs.stat(to);
  return sa.ino === sb.ino && sa.dev === sb.dev ? 'same' : 'different';
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function moveFlatFile(
  basedir: string,
  entityDir: RunScopedEntityDir,
  name: string,
  madeDirs: Set<string>
): Promise<'moved' | 'skipped' | 'gone'> {
  const from = path.join(basedir, entityDir, name);
  const runId = await runIdOfFlatFile(entityDir, from);
  let toDir: string;
  try {
    if (!runId) throw new Error('no run id');
    toDir = path.join(basedir, runEntityDir(entityDir, runId));
  } catch {
    return 'skipped';
  }
  if (!madeDirs.has(toDir)) {
    await fs.mkdir(toDir, { recursive: true });
    madeDirs.add(toDir);
  }
  const to = path.join(toDir, name);
  // `rename` would replace a file already at the destination, so look first.
  // Only a concurrent pass can put one there between this check and the
  // rename, and it would be moving this very file (event files are never
  // rewritten, and nothing writes a run-scoped path before the pass that
  // gates it has finished).
  if (await exists(to)) {
    const relation = await compareWithDestination(from, to);
    if (relation === 'gone') return 'gone';
    if (relation === 'different') return 'skipped';
    // Hard-linked at both paths (an interrupted copy): drop the flat name.
    try {
      await withWindowsRetry(() => fs.unlink(from));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return 'moved';
  }
  try {
    await withWindowsRetry(() => fs.rename(from, to));
  } catch (error) {
    // A concurrent pass moved it first.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw error;
  }
  return 'moved';
}

/**
 * Move every flat event and step file in `basedir` into its run's
 * subdirectory. Safe to run concurrently with itself, and to interrupt.
 */
export async function migrateFlatRunScopedFiles(
  basedir: string,
  options: { onStart?: (fileCount: number) => void } = {}
): Promise<FlatLayoutMigrationResult> {
  const result: FlatLayoutMigrationResult = { moved: 0, skipped: 0 };
  const madeDirs = new Set<string>();
  const pending: [RunScopedEntityDir, string[]][] = [];
  for (const entityDir of RUN_SCOPED_ENTITY_DIRS) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(basedir, entityDir), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    // Only finished entity files. A `*.json.tmp.<id>` is a write that has not
    // been renamed into place yet (or never will be); its writer still
    // expects the flat path, and a crashed one leaves debris either way.
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
    if (names.length > 0) pending.push([entityDir, names]);
  }
  const total = pending.reduce((n, [, names]) => n + names.length, 0);
  if (total > 0) options.onStart?.(total);
  for (const [entityDir, names] of pending) {
    const concurrency = 32;
    for (let start = 0; start < names.length; start += concurrency) {
      const outcomes = await Promise.all(
        names
          .slice(start, start + concurrency)
          .map((name) => moveFlatFile(basedir, entityDir, name, madeDirs))
      );
      for (const outcome of outcomes) {
        if (outcome === 'moved') result.moved++;
        else if (outcome === 'skipped') result.skipped++;
      }
    }
  }
  return result;
}

// Per-process memo, on `globalThis` so several bundled copies of this module
// share it (see `globalSingleton`). Failed passes are forgotten and retried
// by the next storage call.
const layoutState = globalSingleton(
  '@workflow/world-local//runScopedLayout',
  1,
  () => ({ passes: new Map<string, Promise<void>>() })
);

/**
 * Resolve once `basedir` holds no flat event or step files, converting it on
 * the first call in this process. Every storage entry point awaits this, so
 * nothing reads the run-scoped layout before the conversion has finished.
 */
export function ensureRunScopedLayout(basedir: string): Promise<void> {
  const key = path.resolve(basedir);
  let pass = layoutState.passes.get(key);
  if (!pass) {
    pass = (async () => {
      const startedAt = Date.now();
      const { moved, skipped } = await migrateFlatRunScopedFiles(key, {
        onStart: (fileCount) => {
          if (fileCount >= 1000) {
            console.log(
              `[world-local] Moving ${fileCount} event and step files in ` +
                `${key} into per-run directories (one-time, this can take ` +
                `a while)...`
            );
          }
        },
      });
      if (moved > 0 || skipped > 0) {
        console.log(
          `[world-local] Moved ${moved} event and step files into per-run ` +
            `directories in ${Date.now() - startedAt}ms` +
            (skipped > 0 ? ` (left ${skipped} in place)` : '')
        );
      }
    })().catch((error) => {
      layoutState.passes.delete(key);
      throw error;
    });
    layoutState.passes.set(key, pass);
  }
  return pass;
}

/** Forget completed passes (tests). */
export function resetRunScopedLayoutCache(): void {
  layoutState.passes.clear();
}

/**
 * Wrap every async method of a storage object so it first awaits
 * {@link ensureRunScopedLayout}. Methods listed in `syncMethods` are passed
 * through untouched.
 */
export function gateOnRunScopedLayout<T extends object>(
  basedir: string,
  target: T,
  syncMethods: readonly string[] = []
): T {
  const gated: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(target)) {
    if (typeof value !== 'function' || syncMethods.includes(name)) {
      gated[name] = value;
      continue;
    }
    gated[name] = async (...args: unknown[]) => {
      await ensureRunScopedLayout(basedir);
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  }
  return gated as T;
}
