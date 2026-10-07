import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { globalSingleton } from '@workflow/utils';
import { z } from 'zod';
import {
  RUN_SCOPED_ENTITY_DIRS,
  type RunScopedEntityDir,
  readJSON,
  withWindowsRetry,
} from '../fs.js';

/**
 * Where a data directory keeps its event and step files.
 *
 * - `flat`: every file directly in `events/` and `steps/`, as every release
 *   before run-scoped storage wrote it. A per-run read lists the whole
 *   directory and filters by name, so it costs time proportional to every run
 *   the directory has ever held. Still fully supported: a data directory is
 *   never converted by an ordinary read or write.
 * - `run-scoped`: one subdirectory per run, `events/<runId>/` and
 *   `steps/<runId>/`, under the same file names. Per-run reads list only
 *   that run.
 *
 * The layout is recorded in `<dataDir>/layout.json`. No marker means `flat`.
 * Only two things write it:
 *
 * - The owner initializing a brand-new data directory (`initDataDir` in
 *   `start()`), which selects `run-scoped` with an exclusive create.
 * - An explicit conversion ({@link convertLayout}: the `workflow-local-layout`
 *   command, or `start()` with `migrateLayout`). A conversion holds an
 *   exclusive lock, refuses to run while any other process of this package
 *   has the data directory open, and publishes the transitional states
 *   `migrating` / `flattening` while files move. A process that finds a
 *   transitional marker refuses to open the store until the conversion is
 *   finished, so no reader ever sees files mid-move.
 *
 * Coordination with other processes of this package is by registration, not
 * timing. Each process registers a holder file under `.layout/holders/`
 * *before* reading the marker, then pins the layout it read for its lifetime.
 * A conversion publishes its transitional marker *before* listing holders.
 * So either the process sees the transitional marker and refuses, or the
 * conversion sees the holder and refuses; there is no interleaving in which a
 * registered process keeps using a layout that is being changed under it. A
 * holder whose process is gone (same host, `kill(pid, 0)` reports `ESRCH`)
 * is stale and ignored.
 *
 * Processes running older releases do not register and do not read the
 * marker. They must be stopped before a conversion; nothing can detect an
 * idle one. A conversion warns about recently modified flat files as a hint,
 * not as proof that no older writer is running.
 */

export type StoreLayout = 'flat' | 'run-scoped';
type MarkerState = 'run-scoped' | 'migrating' | 'flattening';

export const LAYOUT_MARKER_FILE = 'layout.json';
/** Holder registrations and the conversion lock. Never removed by `clear()`. */
export const LAYOUT_META_DIR = '.layout';
const MARKER_SCHEMA_VERSION = 1;

const MarkerSchema = z.object({
  schema: z.number(),
  state: z.string(),
});

export type DataDirLayoutErrorCode =
  | 'MALFORMED_MARKER'
  | 'UNSUPPORTED_MARKER'
  | 'CONVERSION_IN_PROGRESS'
  | 'CONVERSION_BUSY'
  | 'STORE_IN_USE'
  | 'CONVERSION_INCOMPLETE';

export class DataDirLayoutError extends Error {
  readonly code: DataDirLayoutErrorCode;
  constructor(code: DataDirLayoutErrorCode, message: string) {
    super(message);
    this.name = 'DataDirLayoutError';
    this.code = code;
  }
}

function markerPath(basedir: string): string {
  return path.join(basedir, LAYOUT_MARKER_FILE);
}

function isErrno(error: unknown, ...codes: string[]): boolean {
  return codes.includes((error as NodeJS.ErrnoException)?.code ?? '');
}

/**
 * The marker's state, or `null` when there is none. A marker this release
 * cannot interpret is an error, never silently treated as `flat`: it was
 * written by a newer release or damaged, and guessing could hide data.
 */
async function readMarker(basedir: string): Promise<MarkerState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(markerPath(basedir), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
  let parsed: z.infer<typeof MarkerSchema>;
  try {
    parsed = MarkerSchema.parse(JSON.parse(raw));
  } catch {
    throw new DataDirLayoutError(
      'MALFORMED_MARKER',
      `${markerPath(basedir)} is not a valid layout marker. Restore it from ` +
        `a backup or remove it only if events/ and steps/ hold no run ` +
        `subdirectories.`
    );
  }
  if (
    parsed.schema !== MARKER_SCHEMA_VERSION ||
    !['run-scoped', 'migrating', 'flattening'].includes(parsed.state)
  ) {
    throw new DataDirLayoutError(
      'UNSUPPORTED_MARKER',
      `${markerPath(basedir)} (schema ${parsed.schema}, state ` +
        `"${parsed.state}") was written by a newer @workflow/world-local. ` +
        `Upgrade to read this data directory.`
    );
  }
  return parsed.state as MarkerState;
}

function markerContent(state: MarkerState): string {
  return `${JSON.stringify(
    {
      schema: MARKER_SCHEMA_VERSION,
      state,
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  )}\n`;
}

/** Atomically replace the marker (temp file + rename). Conversion only. */
async function publishMarker(
  basedir: string,
  state: MarkerState
): Promise<void> {
  const tmp = `${markerPath(basedir)}.tmp.${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, markerContent(state), { flag: 'wx' });
  try {
    await withWindowsRetry(() => fs.rename(tmp, markerPath(basedir)));
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

async function removeMarker(basedir: string): Promise<void> {
  try {
    await withWindowsRetry(() => fs.unlink(markerPath(basedir)));
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

/**
 * Select the run-scoped layout for a brand-new data directory. Competing
 * initializers race on a hard link of a fully written temp file, so exactly
 * one publishes and every one of them ends up agreeing on what is there.
 * Called by `initDataDir` before it writes `version.txt`; readers check
 * `version.txt` before the marker, so none can pin `flat` in between.
 */
export async function initializeLayoutMarker(basedir: string): Promise<void> {
  const tmp = `${markerPath(basedir)}.tmp.${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, markerContent('run-scoped'), { flag: 'wx' });
  try {
    await fs.link(tmp, markerPath(basedir));
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
    // Another initializer won; validate what it published.
    await readMarker(basedir);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Per-process state
// ---------------------------------------------------------------------------

interface BasedirState {
  /** Layout this process uses; set once the store has been opened. */
  layout?: StoreLayout;
  /** Pinned: the store is initialized and this process is registered. */
  pinned: boolean;
  /** This process's holder file, `null` if it could not register. */
  holder?: string | null;
  opening?: Promise<StoreLayout>;
  /** A conversion started by this process (`start()` with migrateLayout). */
  converting?: Promise<unknown>;
  inFlight: number;
  drained?: () => void;
}

const layoutState = globalSingleton(
  '@workflow/world-local//storeLayout',
  1,
  () => ({
    dirs: new Map<string, BasedirState>(),
    exitHookInstalled: false,
    warnedReadOnly: new Set<string>(),
  })
);

function stateFor(basedir: string): BasedirState {
  const key = path.resolve(basedir);
  let state = layoutState.dirs.get(key);
  if (!state) {
    state = { pinned: false, inFlight: 0 };
    layoutState.dirs.set(key, state);
  }
  return state;
}

function installExitHook(): void {
  if (layoutState.exitHookInstalled) return;
  layoutState.exitHookInstalled = true;
  process.once('exit', () => {
    for (const state of layoutState.dirs.values()) {
      if (state.holder) {
        try {
          unlinkSync(state.holder);
        } catch {
          // Already gone; a leftover one is detected as stale anyway.
        }
      }
    }
  });
}

function holdersDir(basedir: string): string {
  return path.join(basedir, LAYOUT_META_DIR, 'holders');
}

async function registerHolder(basedir: string): Promise<string | null> {
  const dir = holdersDir(basedir);
  const file = path.join(
    dir,
    `${os.hostname()}-${process.pid}-${randomBytes(4).toString('hex')}.json`
  );
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
      }),
      { flag: 'wx' }
    );
  } catch (error) {
    if (isErrno(error, 'EROFS', 'EACCES', 'EPERM')) {
      const key = path.resolve(basedir);
      if (!layoutState.warnedReadOnly.has(key)) {
        layoutState.warnedReadOnly.add(key);
        console.warn(
          `[world-local] ${key} is not writable; reading it without ` +
            `registering. Do not convert its layout while this process is ` +
            `running.`
        );
      }
      return null;
    }
    throw error;
  }
  installExitHook();
  return file;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function openStore(basedir: string): Promise<StoreLayout> {
  const state = stateFor(basedir);
  if (!(await exists(basedir))) {
    // Nothing to read yet; decide again once the owner creates it.
    state.layout = 'flat';
    return 'flat';
  }
  if (state.holder === undefined) {
    state.holder = await registerHolder(basedir);
  }
  // `version.txt` first: initializers publish the marker before it.
  const initialized = await exists(path.join(basedir, 'version.txt'));
  let marker: MarkerState | null;
  try {
    marker = await readMarker(basedir);
  } catch (error) {
    await releaseHolder(basedir);
    throw error;
  }
  if (marker === 'migrating' || marker === 'flattening') {
    // Unregister so the conversion this is waiting on can resume.
    await releaseHolder(basedir);
    throw new DataDirLayoutError(
      'CONVERSION_IN_PROGRESS',
      `${path.resolve(basedir)} is being converted ` +
        `(${marker === 'migrating' ? 'to per-run directories' : 'back to the flat layout'}), ` +
        `or a conversion was interrupted. Finish it with ` +
        `\`workflow-local-layout ${marker === 'migrating' ? 'migrate' : 'flatten'} ${path.resolve(basedir)}\`.`
    );
  }
  const layout: StoreLayout = marker === 'run-scoped' ? 'run-scoped' : 'flat';
  state.layout = layout;
  state.pinned = state.holder !== null && (initialized || marker !== null);
  return layout;
}

/**
 * Open `basedir` for this process (once) and return its layout. Every
 * events/steps/hooks storage call awaits this before touching files.
 */
export async function resolveStoreLayout(
  basedir: string
): Promise<StoreLayout> {
  const state = stateFor(basedir);
  while (state.converting) {
    await state.converting.catch(() => {});
  }
  if (state.pinned && state.layout) return state.layout;
  if (!state.opening) {
    state.opening = openStore(basedir).finally(() => {
      state.opening = undefined;
    });
  }
  return state.opening;
}

/**
 * The layout this process resolved for `basedir`. Synchronous, for path
 * construction inside storage calls that already awaited
 * {@link resolveStoreLayout}.
 */
export function storeLayoutOf(basedir: string): StoreLayout {
  const layout = stateFor(basedir).layout;
  if (!layout) {
    throw new Error(
      `[world-local] storage layout of ${basedir} used before the store was opened`
    );
  }
  return layout;
}

async function releaseHolder(basedir: string): Promise<void> {
  const state = stateFor(basedir);
  if (state.holder) await fs.unlink(state.holder).catch(() => {});
  state.holder = undefined;
  state.pinned = false;
}

/** Forget all per-process layout state and unregister (tests). */
export async function resetStoreLayoutState(): Promise<void> {
  for (const [dir, state] of layoutState.dirs) {
    if (state.holder) await fs.unlink(state.holder).catch(() => {});
    layoutState.dirs.delete(dir);
  }
  layoutState.warnedReadOnly.clear();
}

/**
 * Wrap every async method of a storage object so it first awaits
 * {@link resolveStoreLayout}, and is counted in flight so a conversion
 * started by this process waits for it. Methods listed in `syncMethods` are
 * passed through untouched.
 */
export function gateOnStoreLayout<T extends object>(
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
      const state = stateFor(basedir);
      await resolveStoreLayout(basedir);
      state.inFlight++;
      try {
        return await (value as (...a: unknown[]) => unknown).apply(
          target,
          args
        );
      } finally {
        state.inFlight--;
        if (state.inFlight === 0) state.drained?.();
      }
    };
  }
  return gated as T;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

interface Holder {
  file: string;
  pid: number;
  hostname: string;
}

async function liveHolders(
  basedir: string,
  exclude: string | null | undefined
): Promise<Holder[]> {
  const dir = holdersDir(basedir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
  const live: Holder[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    if (exclude && path.resolve(file) === path.resolve(exclude)) continue;
    let info: { pid?: unknown; hostname?: unknown };
    try {
      info = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      // A holder being written right now, or garbage: count it as live.
      live.push({ file, pid: -1, hostname: '?' });
      continue;
    }
    const pid = typeof info.pid === 'number' ? info.pid : -1;
    const hostname = typeof info.hostname === 'string' ? info.hostname : '?';
    if (hostname === os.hostname() && pid > 0 && !isProcessAlive(pid)) {
      await fs.unlink(file).catch(() => {});
      continue;
    }
    live.push({ file, pid, hostname });
  }
  return live;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}

/**
 * Exclusive conversion lock: a directory created with `mkdir` (atomic),
 * holding its owner's pid. A lock whose owner is gone (same host, `ESRCH`)
 * is broken; one held by a live or unknown owner refuses.
 */
async function acquireConversionLock(
  basedir: string
): Promise<() => Promise<void>> {
  const lockDir = path.join(basedir, LAYOUT_META_DIR, 'convert.lock');
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        path.join(lockDir, 'owner.json'),
        JSON.stringify({ pid: process.pid, hostname: os.hostname() })
      );
      return () => fs.rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    let owner: { pid?: unknown; hostname?: unknown } = {};
    try {
      owner = JSON.parse(
        await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8')
      );
    } catch {
      // Owner file not written yet or unreadable: treat as held.
    }
    const stale =
      owner.hostname === os.hostname() &&
      typeof owner.pid === 'number' &&
      !isProcessAlive(owner.pid);
    if (!stale) break;
    await fs.rm(lockDir, { recursive: true, force: true });
  }
  throw new DataDirLayoutError(
    'CONVERSION_BUSY',
    `Another layout conversion holds ${lockDir}. Wait for it to finish; if ` +
      `no conversion is running, remove that directory.`
  );
}

export interface LayoutIssue {
  /** Path relative to the data directory. */
  path: string;
  reason: string;
}

export interface LayoutConversionReport {
  target: StoreLayout;
  /** Files moved to their target location. */
  moved: number;
  /** Source copies dropped because the target already held the same file (same inode or identical bytes). */
  dropped: number;
  /** Files that could not be placed; left where they were, or quarantined. */
  conflicts: LayoutIssue[];
  /** Files moved to `.layout/quarantine/` (with `quarantine: true`). */
  quarantined: number;
  /** Source files modified within the last minute: a hint that an older writer may still be running. */
  recentlyModified: number;
  /** Other processes of this package that have the store open. Non-empty means nothing was done. */
  liveHolders: { pid: number; hostname: string; file: string }[];
  /** The marker now records `target`. */
  completed: boolean;
}

/** Per-entity id prefix of the second half of a file id, `${runId}-${id}`. */
const ENTITY_ID_PREFIX: Record<RunScopedEntityDir, string> = {
  events: '-evnt_',
  steps: '-step_',
};

const RunIdSchema = z.object({ runId: z.string() });

/**
 * The run a flat file belongs to. Its name is `${runId}-${entityId}` plus an
 * optional `.${tag}` and the `.json` extension, but both halves may contain
 * `-` (custom run ids, and step ids such as `step_a-step_b`), so the name
 * alone is only conclusive when the `-evnt_` / `-step_` separator occurs
 * exactly once. Otherwise the run id stored in the file decides, provided the
 * name really starts with it.
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

function isSafeRunDirName(runId: string): boolean {
  return (
    runId.length > 0 &&
    runId !== '.' &&
    runId !== '..' &&
    !runId.includes('/') &&
    !runId.includes('\\') &&
    !runId.includes('\0')
  );
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (sa.ino === sb.ino && sa.dev === sb.dev) return true;
  if (sa.size !== sb.size) return false;
  const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  return ba.equals(bb);
}

/**
 * Move `from` to `to` without ever replacing a file. Exclusivity comes from
 * the conversion protocol (lock + no registered holders), so check-then-
 * rename cannot race with this package; an identical file already at `to` is
 * a leftover of an interrupted run and the source copy is dropped.
 */
async function placeFile(
  from: string,
  to: string
): Promise<'moved' | 'dropped' | 'conflict'> {
  if (await exists(to)) {
    if (!(await sameFile(from, to))) return 'conflict';
    await withWindowsRetry(() => fs.unlink(from));
    return 'dropped';
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await withWindowsRetry(() => fs.rename(from, to));
  return 'moved';
}

async function quarantine(
  basedir: string,
  from: string,
  entityDir: RunScopedEntityDir
): Promise<void> {
  const dir = path.join(basedir, LAYOUT_META_DIR, 'quarantine', entityDir);
  await fs.mkdir(dir, { recursive: true });
  const base = path.basename(from);
  for (let n = 0; ; n++) {
    const to = path.join(dir, n === 0 ? base : `${base}.${n}`);
    if (await exists(to)) continue;
    await withWindowsRetry(() => fs.rename(from, to));
    return;
  }
}

async function readdirOrEmpty(
  dir: string
): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
}

/** Finished entity files only: `*.json.tmp.<id>` is debris of a crashed write. */
const isEntityFile = (entry: import('node:fs').Dirent) =>
  entry.isFile() && entry.name.endsWith('.json');

async function countFlatFiles(basedir: string): Promise<number> {
  let n = 0;
  for (const entityDir of RUN_SCOPED_ENTITY_DIRS) {
    for (const entry of await readdirOrEmpty(path.join(basedir, entityDir))) {
      if (isEntityFile(entry)) n++;
    }
  }
  return n;
}

async function countScopedFiles(basedir: string): Promise<number> {
  let n = 0;
  for (const entityDir of RUN_SCOPED_ENTITY_DIRS) {
    const root = path.join(basedir, entityDir);
    for (const entry of await readdirOrEmpty(root)) {
      if (!entry.isDirectory()) continue;
      n += (await readdirOrEmpty(path.join(root, entry.name))).length;
    }
  }
  return n;
}

/**
 * Loose flat event/step files in a run-scoped store: written by an older
 * release after the conversion. One `readdir` per entity directory, which
 * holds one entry per run.
 */
export async function findStrayFlatFiles(basedir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entityDir of RUN_SCOPED_ENTITY_DIRS) {
    for (const entry of await readdirOrEmpty(path.join(basedir, entityDir))) {
      if (isEntityFile(entry)) out.push(path.join(entityDir, entry.name));
    }
  }
  return out;
}

const RECENT_MS = 60_000;

async function migrateFiles(
  basedir: string,
  report: LayoutConversionReport,
  options: ConvertLayoutOptions
): Promise<void> {
  const now = Date.now();
  for (const entityDir of RUN_SCOPED_ENTITY_DIRS) {
    const root = path.join(basedir, entityDir);
    const names = (await readdirOrEmpty(root))
      .filter(isEntityFile)
      .map((e) => e.name);
    const concurrency = 32;
    for (let start = 0; start < names.length; start += concurrency) {
      await Promise.all(
        names.slice(start, start + concurrency).map(async (name) => {
          const from = path.join(root, name);
          const rel = path.join(entityDir, name);
          const st = await fs.stat(from);
          if (now - st.mtimeMs < RECENT_MS) report.recentlyModified++;
          const runId = await runIdOfFlatFile(entityDir, from);
          let reason: string | null = null;
          if (!runId) {
            reason =
              'cannot determine its run (unparseable, or its stored runId does not match its name)';
          } else if (!isSafeRunDirName(runId)) {
            reason = `run id "${runId}" is not a safe directory name`;
          } else {
            const outcome = await placeFile(from, path.join(root, runId, name));
            if (outcome === 'moved') report.moved++;
            else if (outcome === 'dropped') report.dropped++;
            else
              reason = `a different file already exists at ${path.join(entityDir, runId, name)}`;
          }
          if (reason) {
            report.conflicts.push({ path: rel, reason });
            if (options.quarantine) {
              await quarantine(basedir, from, entityDir);
              report.quarantined++;
            }
          }
        })
      );
    }
  }
}

async function flattenFiles(
  basedir: string,
  report: LayoutConversionReport,
  options: ConvertLayoutOptions
): Promise<void> {
  const now = Date.now();
  for (const entityDir of RUN_SCOPED_ENTITY_DIRS) {
    const root = path.join(basedir, entityDir);
    for (const runEntry of await readdirOrEmpty(root)) {
      if (!runEntry.isDirectory()) continue;
      const runDir = path.join(root, runEntry.name);
      for (const entry of await readdirOrEmpty(runDir)) {
        const from = path.join(runDir, entry.name);
        const rel = path.join(entityDir, runEntry.name, entry.name);
        if (!entry.isFile()) {
          report.conflicts.push({ path: rel, reason: 'not a regular file' });
          continue;
        }
        const st = await fs.stat(from);
        if (now - st.mtimeMs < RECENT_MS) report.recentlyModified++;
        const outcome = await placeFile(from, path.join(root, entry.name));
        if (outcome === 'moved') report.moved++;
        else if (outcome === 'dropped') report.dropped++;
        else {
          report.conflicts.push({
            path: rel,
            reason: `a different file already exists at ${path.join(entityDir, entry.name)}`,
          });
          if (options.quarantine) {
            await quarantine(basedir, from, entityDir);
            report.quarantined++;
          }
        }
      }
      await fs.rmdir(runDir).catch(() => {});
    }
  }
}

export interface ConvertLayoutOptions {
  /** Move files that cannot be placed into `.layout/quarantine/` so the conversion can complete. */
  quarantine?: boolean;
  /** Test hook: runs after the transitional marker is published and holders were checked, before any file moves. */
  onBeforeMove?: () => Promise<void> | void;
}

/**
 * Convert `basedir` to `target` (`run-scoped` = migrate, `flat` = roll back).
 * Idempotent and resumable: an interrupted conversion leaves the
 * transitional marker, which keeps every process of this package out until
 * the same command is run again.
 *
 * The marker records `target` only once no file remains in the source
 * layout. Anything that cannot be placed (a different file already at the
 * destination, or a flat file whose run cannot be determined) is reported in
 * `conflicts`, left where it is, and the store stays in the transitional
 * state; pass `quarantine` to move those files aside and complete.
 */
export async function convertLayout(
  basedir: string,
  target: StoreLayout,
  options: ConvertLayoutOptions = {}
): Promise<LayoutConversionReport> {
  const resolved = path.resolve(basedir);
  const state = stateFor(resolved);
  const report: LayoutConversionReport = {
    target,
    moved: 0,
    dropped: 0,
    conflicts: [],
    quarantined: 0,
    recentlyModified: 0,
    liveHolders: [],
    completed: false,
  };
  const release = await acquireConversionLock(resolved);
  try {
    const previous = await readMarker(resolved);
    const transitional: MarkerState =
      target === 'run-scoped' ? 'migrating' : 'flattening';
    if (target === 'run-scoped' && previous === 'run-scoped') {
      if ((await countFlatFiles(resolved)) === 0) {
        report.completed = true;
        return report;
      }
    }
    if (target === 'flat' && previous === null) {
      if ((await countScopedFiles(resolved)) === 0) {
        report.completed = true;
        return report;
      }
    }
    await publishMarker(resolved, transitional);
    // After publishing: any process that registered before this point is
    // listed here, and any that registers after it sees the marker.
    report.liveHolders = (await liveHolders(resolved, state.holder)).map(
      ({ pid, hostname, file }) => ({
        pid,
        hostname,
        file: path.relative(resolved, file),
      })
    );
    if (report.liveHolders.length > 0) {
      // Nothing moved yet: put the previous state back.
      if (previous === null) await removeMarker(resolved);
      else await publishMarker(resolved, previous);
      return report;
    }
    await options.onBeforeMove?.();
    if (target === 'run-scoped') await migrateFiles(resolved, report, options);
    else await flattenFiles(resolved, report, options);

    const remaining =
      target === 'run-scoped'
        ? await countFlatFiles(resolved)
        : await countScopedFiles(resolved);
    if (remaining === 0) {
      if (target === 'run-scoped') await publishMarker(resolved, 'run-scoped');
      else await removeMarker(resolved);
      report.completed = true;
    }
    return report;
  } finally {
    await release();
  }
}

/**
 * Convert from inside a process that has the store open (`start()` with
 * `migrateLayout`). Storage calls of this process wait for it and those in
 * flight finish first; afterwards the process re-opens the store in the new
 * layout.
 */
export async function convertLayoutInProcess(
  basedir: string,
  target: StoreLayout,
  options: ConvertLayoutOptions = {}
): Promise<LayoutConversionReport> {
  const state = stateFor(basedir);
  const run = (async () => {
    if (state.inFlight > 0) {
      await new Promise<void>((resolve) => {
        state.drained = resolve;
      });
      state.drained = undefined;
    }
    try {
      return await convertLayout(basedir, target, options);
    } finally {
      state.pinned = false;
      state.layout = undefined;
    }
  })();
  state.converting = run;
  try {
    return await run;
  } finally {
    state.converting = undefined;
  }
}

/** Human-readable summary of a report, for stderr. */
export function describeConversion(
  basedir: string,
  report: LayoutConversionReport
): string {
  const lines: string[] = [];
  const where = path.resolve(basedir);
  if (report.liveHolders.length > 0) {
    lines.push(
      `Refused to convert ${where}: ${report.liveHolders.length} other ` +
        `process(es) have it open. Stop them and retry:`
    );
    for (const h of report.liveHolders) {
      lines.push(`  pid ${h.pid} on ${h.hostname} (${h.file})`);
    }
    return lines.join('\n');
  }
  const verb =
    report.target === 'run-scoped' ? 'per-run directories' : 'the flat layout';
  lines.push(
    `${report.completed ? 'Converted' : 'Partially converted'} ${where} to ${verb}: ` +
      `${report.moved} moved, ${report.dropped} duplicate(s) dropped` +
      (report.quarantined ? `, ${report.quarantined} quarantined` : '') +
      '.'
  );
  if (report.recentlyModified > 0) {
    lines.push(
      `Warning: ${report.recentlyModified} file(s) were modified in the last ` +
        `minute. If a process running an older @workflow/world-local is ` +
        `still using this directory, stop it: it does not see the new layout.`
    );
  }
  if (report.conflicts.length > 0) {
    lines.push(
      `${report.conflicts.length} file(s) could not be placed${report.quarantined ? ' and were moved to .layout/quarantine/' : ' and were left in place'}:`
    );
    for (const c of report.conflicts.slice(0, 20)) {
      lines.push(`  ${c.path}: ${c.reason}`);
    }
    if (report.conflicts.length > 20) {
      lines.push(`  … and ${report.conflicts.length - 20} more`);
    }
  }
  if (!report.completed) {
    lines.push(
      'The data directory stays locked for this package until the conversion ' +
        'completes. Resolve the files above (or rerun with --quarantine) and ' +
        'run the same command again.'
    );
  }
  return lines.join('\n');
}
