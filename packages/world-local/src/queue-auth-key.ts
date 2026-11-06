import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  generateQueueAuthKey,
  globalSingleton,
  isWellFormedQueueAuthKey,
  setQueueAuthKeySource,
} from '@workflow/utils';
import { ensureDataDir } from './init.js';

/** The key file, inside the data directory. */
export const QUEUE_AUTH_KEY_FILE = 'queue-auth-key';

/**
 * How a Local World handles the app's queue auth key:
 *
 * - `'regenerate'` (the default, and what `getWorld()` creates): writes a new
 *   key to the data directory when the World is created, before its queue
 *   sends anything, and checks deliveries against it. An app, or a script that
 *   calls `start()`, creates its World this way.
 * - `'read'`: only reads the key the app wrote, to send deliveries the app
 *   accepts. Never creates or replaces the key file, and never creates the
 *   data directory for it. For tools that act on a running app's data
 *   directory: the CLI, the web UI, and world-postgres's internal Local World.
 */
export type QueueAuthKeyMode = 'regenerate' | 'read';

/** Reloads of the key file at most this often, on the receiving side. */
const RELOAD_INTERVAL_MS = 250;

interface KeyFileState {
  /** The key this process holds: generated, or last read from the file. */
  key: string | undefined;
  /** This process's one regeneration for the directory, once started. */
  regenerated: Promise<void> | undefined;
  /** Whether this process wrote the directory's key (it owns rewriting it). */
  writer: boolean;
  /** A reload in flight, shared by everyone who asks meanwhile. */
  reloading: Promise<string | undefined> | undefined;
  lastReloadAt: number;
  /** One log line per directory for a key that cannot be written. */
  loggedWriteFailure: boolean;
}

/**
 * Per data directory, process-wide: bundler layers (Next.js compiles several)
 * and HMR evaluate this module more than once, and none of them may generate
 * a second key for the same directory.
 */
const keyFiles = () =>
  globalSingleton('@workflow/world-local//queueAuthKeyFiles', 1, () => ({
    byDir: new Map<string, KeyFileState>(),
  }));

function stateFor(dir: string): KeyFileState {
  const { byDir } = keyFiles();
  let state = byDir.get(dir);
  if (!state) {
    state = {
      key: undefined,
      regenerated: undefined,
      writer: false,
      reloading: undefined,
      lastReloadAt: Number.NEGATIVE_INFINITY,
      loggedWriteFailure: false,
    };
    byDir.set(dir, state);
  }
  return state;
}

/**
 * The key in the file, or `undefined` when there is none or it is not a key
 * (empty, truncated, edited). Never throws.
 */
export async function readQueueAuthKeyFile(
  dir: string
): Promise<string | undefined> {
  try {
    const value = (
      await readFile(path.join(dir, QUEUE_AUTH_KEY_FILE), 'utf8')
    ).trim();
    return isWellFormedQueueAuthKey(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes `key` to the file: owner-only, through a temporary file renamed over
 * it, so a reader never sees a partial key. Creates the data directory (with
 * its `.gitignore`) when it is missing.
 */
async function writeQueueAuthKeyFile(dir: string, key: string): Promise<void> {
  await ensureDataDir(dir);
  const tmp = path.join(
    dir,
    `.${QUEUE_AUTH_KEY_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await writeFile(tmp, `${key}\n`, { mode: 0o600, flag: 'wx' });
    // The mode passed to writeFile is masked by the umask.
    await chmod(tmp, 0o600);
    await rename(tmp, path.join(dir, QUEUE_AUTH_KEY_FILE));
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function logWriteFailure(state: KeyFileState, dir: string, error: unknown) {
  if (state.loggedWriteFailure) return;
  state.loggedWriteFailure = true;
  console.error(
    `[world-local] Could not write the queue auth key to ${path.join(dir, QUEUE_AUTH_KEY_FILE)}; ` +
      "this app's own deliveries still authenticate, but the CLI, the web UI and " +
      'other processes of the app cannot until it can be written.',
    { error: String(error) }
  );
}

/** One Local World's view of the app's key, for its queue to send with. */
export interface QueueAuthKey {
  /** The key to send. A regenerating World waits for its key to be written. */
  current(): Promise<string | undefined>;
  /**
   * Re-reads the key from the file after a refusal, and returns it. Another
   * process of the app may have written a new one.
   */
  reload(): Promise<string | undefined>;
  /** Writes this process's key again, after `clear()` removed the directory. */
  restore(): Promise<void>;
}

/**
 * The app's queue auth key for the data directory `dataDir`, in `mode` (see
 * {@link QueueAuthKeyMode}).
 */
export function createQueueAuthKey(
  dataDir: string,
  mode: QueueAuthKeyMode
): QueueAuthKey {
  const dir = path.resolve(dataDir);
  const state = stateFor(dir);

  const reload = (): Promise<string | undefined> => {
    if (state.reloading) return state.reloading;
    const promise = (async () => {
      // Never read the file while this process is still writing its own key:
      // the previous run's key there would replace the new one in memory.
      if (state.regenerated) await state.regenerated;
      const fromFile = await readQueueAuthKeyFile(dir);
      if (fromFile) {
        state.key = fromFile;
      } else if (state.writer && state.key) {
        // The file is gone (`clear()`, a deleted data directory): the process
        // that wrote the key writes it again. Readers never do.
        await writeQueueAuthKeyFile(dir, state.key).catch((error) =>
          logWriteFailure(state, dir, error)
        );
      }
      return state.key;
    })().finally(() => {
      state.reloading = undefined;
    });
    state.reloading = promise;
    return promise;
  };

  if (mode === 'regenerate' && !state.regenerated) {
    // Once per process and directory, first, before this World sends
    // anything: a new key, held in memory at once and written behind it.
    state.writer = true;
    state.key = generateQueueAuthKey();
    const key = state.key;
    state.regenerated = writeQueueAuthKeyFile(dir, key).catch((error) =>
      logWriteFailure(state, dir, error)
    );
    // This process's routes check deliveries against it, and against the
    // key of any other data directory a World in this process regenerated.
    // Reloads are rate-limited: a flood of wrong keys reads the file at most
    // every RELOAD_INTERVAL_MS.
    setQueueAuthKeySource(dir, {
      current: () => state.key,
      reload: async () => {
        const now = Date.now();
        if (!state.reloading && now - state.lastReloadAt < RELOAD_INTERVAL_MS) {
          return state.key;
        }
        state.lastReloadAt = now;
        return reload();
      },
    });
  }

  return {
    async current() {
      if (state.regenerated) await state.regenerated;
      if (state.key === undefined && !state.writer) return reload();
      return state.key;
    },
    reload,
    async restore() {
      if (!state.writer || !state.key) return;
      await writeQueueAuthKeyFile(dir, state.key).catch((error) =>
        logWriteFailure(state, dir, error)
      );
    },
  };
}
