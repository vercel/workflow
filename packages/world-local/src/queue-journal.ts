import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { globalSingleton } from '@workflow/utils';
import { z } from 'zod/v4';
import {
  deleteJSON,
  hasTag,
  isUntagged,
  listJSONFiles,
  resolveWithinBase,
  taggedPath,
  withWindowsRetry,
  write,
} from './fs.js';

/**
 * Directory, under the data directory, that holds one file per message the
 * local queue has accepted and not finished. A process holds its messages in
 * memory, so without this a process that dies loses every message it was
 * delivering. With it, the next `start()` delivers each one again, with the
 * same messageId and a higher attempt, as a queue with a lease does.
 */
export const QUEUE_JOURNAL_DIR = 'queue';

const QueueHolder = z.object({
  pid: z.number().int(),
  host: z.string(),
  /** Chosen once per process: tells this process from an earlier one with the same pid. */
  bootId: z.string(),
});
type QueueHolder = z.infer<typeof QueueHolder>;

const JournalEntry = z.object({
  messageId: z.string(),
  queueName: z.string(),
  /** The message as the delivery loop sends it (UTF-8 JSON). */
  body: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  idempotencyKey: z.string().optional(),
  /** The attempt the message's next delivery carries. */
  attempt: z.number().int().positive(),
  /** Epoch milliseconds before which the next delivery isn't due. */
  dueAt: z.number(),
  holder: QueueHolder,
});
export type JournalEntry = z.infer<typeof JournalEntry>;

/** This process, as the holder of every message its queue loops deliver. */
export function getQueueHolder(): QueueHolder {
  return globalSingleton('@workflow/world-local//queueHolder', 1, () => ({
    pid: process.pid,
    host: hostname(),
    bootId: randomUUID(),
  }));
}

/**
 * Whether the process that held a journaled message is gone, so that nothing
 * else will deliver it. Errs towards "alive": an entry from another host, or
 * one whose pid now belongs to an unrelated process, is left alone, and the
 * run is still recovered by `start()`'s re-enqueue of active runs.
 */
export function isHolderGone(holder: QueueHolder): boolean {
  const self = getQueueHolder();
  if (holder.host !== self.host) return false;
  // Same pid as this process: alive only if it is this very process.
  if (holder.pid === self.pid) return holder.bootId !== self.bootId;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export interface QueueJournal {
  /** Write (or overwrite) a message's entry, held by this process. */
  record(entry: Omit<JournalEntry, 'holder'>): Promise<void>;
  /** Forget a message that was acknowledged or dropped. */
  remove(messageId: string): Promise<void>;
  /**
   * Take over every entry whose holder process is gone, and return them, now
   * held by this process. An entry whose next delivery was already due may
   * have reached its handler before the process died, so its attempt goes up
   * by one; one still waiting out a delay keeps its attempt and its due time.
   */
  claimOrphans(): Promise<JournalEntry[]>;
}

export function createQueueJournal(
  dataDir: string,
  tag: string | undefined
): QueueJournal {
  const dir = resolveWithinBase(dataDir, QUEUE_JOURNAL_DIR);
  const entryPath = (messageId: string) =>
    taggedPath(dataDir, QUEUE_JOURNAL_DIR, messageId, tag);
  // A tagged World recovers only its own tag, and an untagged one only
  // untagged entries, as start()'s re-enqueue of active runs does.
  const isOwnFile = (fileId: string) =>
    tag ? hasTag(fileId, tag) : isUntagged(fileId);

  const writeEntry = (entry: JournalEntry) =>
    write(entryPath(entry.messageId), JSON.stringify(entry), {
      overwrite: true,
    });

  const claim = async (fileId: string): Promise<JournalEntry | undefined> => {
    const filePath = path.join(dir, `${fileId}.json`);
    let entry: JournalEntry;
    try {
      const parsed = JournalEntry.safeParse(
        JSON.parse(await fs.readFile(filePath, 'utf-8'))
      );
      if (!parsed.success) return undefined;
      entry = parsed.data;
    } catch {
      // Gone (another process claimed or finished it), or unreadable.
      return undefined;
    }
    if (!isHolderGone(entry.holder)) return undefined;

    // The rename is the claim: when two processes start together, only one
    // of them moves the file. A process that dies between the rename and the
    // rewrite below loses the message, which start()'s re-enqueue of active
    // runs still covers.
    const self = getQueueHolder();
    const claimPath = `${filePath}.claim-${self.bootId}`;
    try {
      await withWindowsRetry(() => fs.rename(filePath, claimPath));
    } catch {
      return undefined;
    }
    const now = Date.now();
    const due = entry.dueAt <= now;
    const claimed: JournalEntry = {
      ...entry,
      attempt: due ? entry.attempt + 1 : entry.attempt,
      dueAt: due ? now : entry.dueAt,
      holder: self,
    };
    await writeEntry(claimed);
    await withWindowsRetry(() => fs.unlink(claimPath)).catch(() => {});
    return claimed;
  };

  return {
    record: (entry) => writeEntry({ ...entry, holder: getQueueHolder() }),
    remove: (messageId) => deleteJSON(entryPath(messageId)),
    async claimOrphans() {
      const fileIds = (await listJSONFiles(dir)).filter(isOwnFile);
      const claimed = await Promise.all(fileIds.map(claim));
      return claimed.filter((entry) => entry !== undefined);
    },
  };
}
