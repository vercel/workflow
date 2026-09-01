import { createHash, randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import {
  type JournalCommitOptions,
  JournalCommitOptionsSchema,
  JournalIdSchema,
  type JournalState,
  JournalStateSchema,
  type Journals,
} from '@workflow/world';
import { lock } from 'proper-lockfile';
import { z } from 'zod';
import {
  ensureDir,
  jsonReplacer,
  readJSON,
  resolveWithinBase,
  withWindowsRetry,
} from './fs.js';

const JOURNAL_REVISION_WIDTH = 16;
const journalEntrySchema = JournalStateSchema.extend({
  idempotencyKey: z.string(),
});

type JournalEntry = z.infer<typeof journalEntrySchema>;

export function createJournals(basedir: string, tag?: string): Journals {
  return {
    async get(rawJournalId) {
      const journalId = JournalIdSchema.parse(rawJournalId);
      return withJournalsLock(basedir, async () => {
        const entries = await readJournalEntries(basedir, journalId, tag);
        const latest = entries.at(-1);
        return latest === undefined ? null : toJournalState(latest);
      });
    },

    async commit(rawJournalId, rawState, rawOptions) {
      const journalId = JournalIdSchema.parse(rawJournalId);
      const state = Uint8Array.from(rawState);
      const options = JournalCommitOptionsSchema.parse(rawOptions);
      const directory = journalDirectory(basedir, journalId, tag);

      return withJournalsLock(basedir, () =>
        withJournalLock(directory, (signal) =>
          commitJournalRevision({
            basedir,
            directory,
            journalId,
            options,
            signal,
            state,
            tag,
          })
        )
      );
    },
  };
}

async function commitJournalRevision(input: {
  basedir: string;
  directory: string;
  journalId: string;
  options: JournalCommitOptions;
  signal: AbortSignal;
  state: Uint8Array;
  tag?: string;
}): Promise<JournalState> {
  const entries = await readJournalEntries(
    input.basedir,
    input.journalId,
    input.tag
  );
  const priorCommit = entries.find(
    (entry) => entry.idempotencyKey === input.options.idempotencyKey
  );
  if (priorCommit !== undefined) {
    if (bytesEqual(priorCommit.state, input.state)) {
      return toJournalState(priorCommit);
    }
    throw new EntityConflictError(
      `Journal "${input.journalId}" idempotency key was reused with different state.`
    );
  }

  const latest = entries.at(-1);
  assertExpectedRevision(input.journalId, latest, input.options);
  const revisionNumber = entries.length + 1;
  if (!Number.isSafeInteger(revisionNumber)) {
    throw new WorkflowWorldError(
      `Journal "${input.journalId}" exhausted its local revision range.`
    );
  }
  const revision = String(revisionNumber);
  const entry: JournalEntry = {
    idempotencyKey: input.options.idempotencyKey,
    journalId: input.journalId,
    revision,
    state: Uint8Array.from(input.state),
  };
  const destination = path.join(
    input.directory,
    `${formatRevision(revisionNumber)}.json`
  );

  input.signal.throwIfAborted();
  const published = await writeJournalRevision(
    destination,
    JSON.stringify(entry, jsonReplacer, 2)
  );
  if (!published) {
    throw new WorkflowWorldError(
      `Journal "${input.journalId}" revision ${revision} was concurrently committed.`
    );
  }
  input.signal.throwIfAborted();
  return toJournalState(entry);
}

export async function clearJournals(
  basedir: string,
  tag?: string
): Promise<void> {
  await withJournalsLock(basedir, async () => {
    await fs.rm(journalScopeDirectory(basedir, tag), {
      recursive: true,
      force: true,
    });
  });
}

function journalScopeDirectory(basedir: string, tag?: string): string {
  const scope = !tag
    ? 'untagged'
    : `tag-${createHash('sha256').update(tag).digest('hex')}`;
  return resolveWithinBase(basedir, 'journals', scope);
}

function journalDirectory(
  basedir: string,
  journalId: string,
  tag?: string
): string {
  const digest = createHash('sha256').update(journalId).digest('hex');
  return path.join(journalScopeDirectory(basedir, tag), digest);
}

async function readJournalEntries(
  basedir: string,
  journalId: string,
  tag?: string
): Promise<JournalEntry[]> {
  const directory = journalDirectory(basedir, journalId, tag);
  let files: string[];
  try {
    files = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const revisionFiles = files.filter((file) => file.endsWith('.json')).sort();
  const entries: JournalEntry[] = [];
  for (let index = 0; index < revisionFiles.length; index++) {
    const expectedRevision = index + 1;
    const expectedFile = `${formatRevision(expectedRevision)}.json`;
    const file = revisionFiles[index];
    if (file !== expectedFile) {
      throw new WorkflowWorldError(
        `Journal "${journalId}" has a missing or malformed revision at ${expectedRevision}.`
      );
    }
    const entry = await readJSON(
      path.join(directory, file),
      journalEntrySchema
    );
    if (
      entry === null ||
      entry.journalId !== journalId ||
      entry.revision !== String(expectedRevision)
    ) {
      throw new WorkflowWorldError(
        `Journal "${journalId}" revision ${expectedRevision} is invalid.`
      );
    }
    entries.push(entry);
  }
  return entries;
}

function assertExpectedRevision(
  journalId: string,
  latest: JournalEntry | undefined,
  options: JournalCommitOptions
): void {
  const actualRevision = latest?.revision ?? null;
  if (options.expectedRevision === actualRevision) return;
  throw new EntityConflictError(
    `Journal "${journalId}" expected revision ${formatNullableRevision(
      options.expectedRevision
    )}, but found ${formatNullableRevision(actualRevision)}.`
  );
}

function formatNullableRevision(revision: string | null): string {
  return revision === null ? 'null' : `"${revision}"`;
}

function formatRevision(revision: number): string {
  return String(revision).padStart(JOURNAL_REVISION_WIDTH, '0');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function toJournalState(entry: JournalEntry): JournalState {
  return {
    journalId: entry.journalId,
    revision: entry.revision,
    state: Uint8Array.from(entry.state),
  };
}

/** Publishes bytes atomically and syncs both contents and directory metadata. */
async function writeJournalRevision(
  filePath: string,
  data: string
): Promise<boolean> {
  const directory = path.dirname(filePath);
  await ensureDir(directory);
  const temporaryPath = `${filePath}.tmp.${randomUUID()}`;
  let temporaryFile: FileHandle | undefined;
  try {
    temporaryFile = await fs.open(temporaryPath, 'wx');
    await temporaryFile.writeFile(data);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;

    try {
      await withWindowsRetry(() => fs.link(temporaryPath, filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    await syncJournalHierarchy(directory);
    return true;
  } finally {
    await temporaryFile?.close().catch(() => {});
    await withWindowsRetry(() => fs.unlink(temporaryPath), 3).catch(() => {});
  }
}

async function syncJournalHierarchy(directory: string): Promise<void> {
  let current = path.resolve(directory);
  while (true) {
    await syncDirectory(current);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      (code !== 'EINVAL' && code !== 'EPERM')
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function withJournalsLock<T>(
  basedir: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const resolved = path.resolve(basedir);
  const digest = createHash('sha256').update(resolved).digest('hex');
  const target = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.journals-${digest}`
  );
  return withFileLock(target, 'journals', fn);
}

async function withJournalLock<T>(
  directory: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return withFileLock(path.join(directory, '.commit'), 'journal commit', fn);
}

async function withFileLock<T>(
  target: string,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  await ensureDir(path.dirname(target));
  const controller = new AbortController();
  let release: () => Promise<void>;
  try {
    release = await lock(target, {
      realpath: false,
      stale: 30_000,
      update: 1_000,
      retries: {
        retries: 350,
        factor: 1,
        minTimeout: 100,
        maxTimeout: 100,
      },
      onCompromised(error) {
        controller.abort(
          new WorkflowWorldError(`${label} lock was compromised.`, {
            cause: error,
          })
        );
      },
    });
  } catch (error) {
    throw new WorkflowWorldError(`Could not acquire ${label} lock.`, {
      cause: error,
    });
  }

  let result: T;
  try {
    result = await fn(controller.signal);
    controller.signal.throwIfAborted();
  } catch (error) {
    if (!controller.signal.aborted) {
      await release().catch(() => {});
    }
    throw error;
  }

  try {
    await release();
  } catch (error) {
    throw new WorkflowWorldError(`Could not release ${label} lock.`, {
      cause: error,
    });
  }
  return result;
}
