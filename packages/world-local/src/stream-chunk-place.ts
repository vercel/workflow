import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Where a stream's chunks land.
 *
 * Readers order a stream's chunks by name, and a live reader delivers each
 * chunk it has not had yet after the ones it already delivered. So a chunk
 * must land under a name that sorts after every chunk already in the stream:
 * one that sorts earlier is read where it landed by a live reader, and ahead
 * of chunks that reader already has by every later read, which moves those
 * chunks' indexes on by one.
 *
 * A chunk is therefore named as it lands: the successor, in name order, of
 * the stream's newest chunk, created with `link()`, which never replaces a
 * file. A writer that named its chunk and then stalled, as a frozen process
 * does, finds the name taken when it goes on, and takes the next one, so no
 * lock is needed. A stream's first chunk is `chnk_0…01`, the successor of
 * the tombstone a purge leaves, which still sorts first.
 *
 * A placer remembers the last chunk it landed in each stream and tries the
 * next name first. A writer elsewhere that landed there makes the link fail,
 * and the placer then lists the stream. The names stay contiguous only while
 * every writer of a stream names chunks this way.
 *
 * There is no fallback for a file system that makes no hard links: a rename
 * there could replace a chunk another process landed under the same name,
 * and world-local already needs hard links for every event it writes (see
 * `writeExclusive` in fs.ts). A link that fails for any reason other than its
 * name being taken, or its directory having gone, fails the write.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHUNK_FILE = /^chnk_([0-9A-HJKMNP-TV-Z]{26})(?![0-9A-Za-z])/;
const FIRST_CHUNK_ID = `${'0'.repeat(25)}1`;

/** The 26-character ULID right after `id` in name order. */
export function chunkSuccessor(id: string): string {
  const digits = id.split('');
  for (let at = digits.length - 1; at >= 0; at -= 1) {
    const value = ALPHABET.indexOf(digits[at]);
    if (value < 0) throw new Error(`not a chunk id: ${id}`);
    if (value < ALPHABET.length - 1) {
      digits[at] = ALPHABET[value + 1];
      return digits.join('');
    }
    digits[at] = ALPHABET[0];
  }
  throw new Error(`no chunk id follows ${id}`);
}

/** The id of the newest chunk in `dir`, of any tag or format, or null. */
export async function newestChunkId(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let newest: string | null = null;
  for (const entry of entries) {
    const id = CHUNK_FILE.exec(entry)?.[1];
    if (id !== undefined && (newest === null || id > newest)) newest = id;
  }
  return newest;
}

export interface ChunkPlacerOptions {
  /** The tag suffix of chunk file names, such as `.vitest-0`, or ''. */
  tagSuffix: string;
  /**
   * Writes a whole temporary file, making its directory. It need not be
   * atomic: readers never list the temporary name.
   */
  writeFile: (filePath: string, data: Buffer) => Promise<void>;
  /** Retries a file operation the platform can fail for a moment. */
  retry: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface ChunkTurn {
  /**
   * Writes `chunks`, waits for the stream's earlier turns, and lands the
   * chunks in order, calling `landed(chunkId, index)` after each. Resolves
   * their ids.
   */
  land(
    dir: string,
    chunks: Buffer[],
    landed?: (chunkId: string, index: number) => void
  ): Promise<string[]>;
  /** Ends the turn, landed or not. The caller must call it. */
  done(): void;
}

export function createChunkPlacer({
  tagSuffix,
  writeFile,
  retry,
}: ChunkPlacerOptions): {
  /**
   * Takes a write's turn in its stream. Called when the write is, before any
   * await, so one placer's writes to a stream land in the order they were
   * called, as they did when each chunk was named then.
   */
  turn(name: string): ChunkTurn;
  /**
   * Forgets the newest chunk landed in `dir`, as once its stream ended, so a
   * placer does not keep one entry per stream it ever wrote. A later write
   * there lists the stream.
   */
  forget(dir: string): void;
} {
  // Each stream's last turn, by name.
  const turns = new Map<string, Promise<void>>();
  // The newest chunk this placer landed in each directory.
  const newest = new Map<string, string | null>();

  const fileOf = (dir: string, id: string) =>
    path.join(dir, `chnk_${id}${tagSuffix}.bin`);

  // Links `temp` in as `target`; resolves the error it failed with, or null.
  const linkInto = (temp: string, target: string) =>
    retry(() => fs.link(temp, target)).then(
      () => null,
      (error: NodeJS.ErrnoException) => error
    );

  const successorOf = (id: string | null) =>
    id === null ? FIRST_CHUNK_ID : chunkSuccessor(id);

  // The newest chunk in `dir` once `taken` turned out to be taken.
  async function newestSince(dir: string, taken: string) {
    const listed = await newestChunkId(dir);
    return listed !== null && listed > taken ? listed : taken;
  }

  async function place(dir: string, temp: string, data: Buffer) {
    let id = newest.has(dir)
      ? (newest.get(dir) as string | null)
      : await newestChunkId(dir);
    let rewritten = false;
    for (;;) {
      const next = successorOf(id);
      const error = await linkInto(temp, fileOf(dir, next));
      if (error === null) {
        newest.set(dir, next);
        return `chnk_${next}`;
      }
      if (error.code === 'EEXIST') {
        // Another writer landed a chunk there: try after the newest.
        id = await newestSince(dir, next);
      } else if (error.code === 'ENOENT' && !rewritten) {
        // The directory went away, as an outside cleanup can make it.
        rewritten = true;
        await writeFile(temp, data);
      } else {
        throw error;
      }
    }
  }

  async function land(
    before: Promise<void> | undefined,
    dir: string,
    chunks: Buffer[],
    landed?: (chunkId: string, index: number) => void
  ): Promise<string[]> {
    // The chunks are written next to where they land, so a link can reach
    // them; readers list only `.bin` and `.json` files.
    const temps = chunks.map(() => path.join(dir, `.${randomUUID()}.tmp`));
    const left = new Set(temps);
    try {
      const written = await Promise.allSettled(
        chunks.map((data, index) => writeFile(temps[index], data))
      );
      const failed = written.find((result) => result.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
      await before;
      const ids: string[] = [];
      for (const [index, temp] of temps.entries()) {
        const id = await place(dir, temp, chunks[index]);
        ids.push(id);
        left.delete(temp);
        await retry(() => fs.unlink(temp)).catch(() => {});
        landed?.(id, index);
      }
      return ids;
    } finally {
      for (const temp of left) {
        await retry(() => fs.unlink(temp)).catch(() => {});
      }
    }
  }

  return {
    turn(name) {
      const before = turns.get(name);
      let done!: () => void;
      const ended = new Promise<void>((resolve) => {
        done = resolve;
      });
      // The next turn lands once this one ended and every turn before it did:
      // a turn that ends early, as a write that fails before it lands does,
      // must not let a later write land ahead of an earlier one still on its
      // way.
      const mine = before ? Promise.all([ended, before]).then(() => {}) : ended;
      turns.set(name, mine);
      void mine.then(() => {
        if (turns.get(name) === mine) turns.delete(name);
      });
      return {
        land: (dir, chunks, landed) => land(before, dir, chunks, landed),
        done,
      };
    },
    forget(dir) {
      newest.delete(dir);
    },
  };
}
