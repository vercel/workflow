/**
 * Slot allocation for the Local World.
 *
 * A slot-numbered run names its events by position: `evnt_…001` is the first
 * event of the run, `evnt_…002` the second. A replay reads the log in slot
 * order, so the order slots are handed out in has to be an order some execution
 * could have produced — which makes allocation strictly *append-only*: a slot is
 * only ever handed out above every position this book has seen.
 *
 * Filling a hole is what that rules out, and it is worth naming why, because the
 * alternative looks appealing (it keeps the log dense). A position left unwritten
 * by an abandoned reservation can sit below events that are already published.
 * Hand it to the next caller and a `step_completed` lands below its own
 * `step_started`; the replay reaches a completion for a step it has not started
 * and diverges, and every later replay diverges the same way. A hole costs a
 * reader the ability to prove its copy of the log is complete. An inversion
 * costs the run.
 *
 * An abandoned reservation is recycled in the one case where it provably sits
 * below nothing: it was the top of the book when it was released, so no sibling
 * was ever handed a position above it and none was read from disk above it. That
 * keeps the common abandonment (a create that converged on another writer's event
 * before publishing anything) from leaving the log permanently un-provable.
 *
 * Three properties do the work:
 *
 *   - An allocation reads the log's tail from disk and picks the position above
 *     both it and the highest one the book knows of, written or outstanding.
 *     Reading disk every time is what makes the order safe across storage
 *     instances: a book that has not seen another instance's writes would
 *     otherwise hand out a position *below* them, and that inversion is silent
 *     because the position is genuinely free (see below for what it costs).
 *   - Once the tail is in hand, handing out a slot is a *synchronous* set
 *     operation, so concurrent callers in one process get distinct slots with no
 *     lock: each bumps the ceiling before the next one reads it.
 *   - The event publish is `writeExclusive`, which is the authority. The tail
 *     read is a hint: when it turns out to be stale (another process wrote the
 *     slot between the read and the publish), the publish fails and the caller is
 *     told so, rather than a duplicate being written or a slot being skipped.
 *
 * The book is per storage instance, and two instances may share a data
 * directory (the cross-process convergence tests rely on exactly that). Their
 * books are then independent, and the loser of a collision gets a conflict it
 * has to resolve by reloading — the same contract as the networked worlds.
 */

import type { WorkflowRun } from '@workflow/world';
import {
  FIRST_SLOT,
  slotFromId,
  usesSlotIdentity,
  WorkflowRunSchema,
} from '@workflow/world';
import { readJSONWithFallback } from '../fs.js';
import { listRunEventIds } from './helpers.js';

interface RunSlots {
  /** Slots proven to be on disk. */
  written: Set<number>;
  /** Slots handed out whose publish has not resolved yet. */
  outstanding: Set<number>;
  /**
   * The highest position this book has ever seen written, claimed or handed out.
   * Allocation goes above it and it never descends, which is what keeps a
   * released position from being recycled below events already published.
   */
  ceiling: number;
}

export interface SlotBook {
  /**
   * Whether `runId`'s events are numbered by slot, read from the run's
   * persisted `specVersion` — never from the build, so a run stays in the mode
   * it was created in for life. A run that does not exist yet is not
   * slot-numbered, and that answer is not cached: the resilient-start path
   * creates the run moments later, and caching "no" would strand it on ULIDs
   * for the rest of this process's life.
   */
  usesSlots(runId: string): Promise<boolean>;
  /**
   * Reserves the position above the run's tail on disk and above every one this
   * book knows of, and at or above `minSlot`. Distinct for every concurrent
   * caller; the publish still has to prove the position was actually free.
   *
   * `minSlot` defaults to the position above the run's first slot, which is
   * reserved for its own `run_created`: that event needs no allocation, and it
   * may not be on disk yet when a concurrent `run_started` allocates (start()
   * issues the creation and the queue send in parallel, and the run entity is
   * published before its event).
   */
  reserve(runId: string, minSlot?: number): Promise<number>;
  /**
   * Records that a caller claimed `slot` itself, so an allocation running
   * alongside it picks a different one. Reserved and released on the same terms
   * as {@link reserve}: the claim is only a hint until the publish proves it.
   */
  claim(runId: string, slot: number): void;
  /**
   * The highest position this run has published, read from the log, or
   * `FIRST_SLOT - 1` for a log with no events.
   *
   * This is the tail a claim has to clear. "Free" is not the property a claim
   * needs: allocation is append-only, so a position left unwritten by an
   * abandoned reservation stays empty for good, and a caller numbering from a
   * snapshot that predates the events above such a hole aims straight at it. Let
   * that write land and the event sits *below* events another replay already
   * consumed — the log stays internally consistent while its order silently
   * changes, which is enough to flip a race between a step and a sleep from one
   * replay to the next.
   *
   * Reading the tail before the write also lets a doomed claim be rejected
   * *before* the create materializes its step, hook or wait: the entity mutation
   * runs ahead of the event publish, so a claim that only fails at the publish
   * leaves an entity behind with no event, and the caller's re-proposal at the
   * next slot then collides with its own orphan. A tail read here is not a
   * promise — the publish is still the authority, and another instance sharing
   * the data directory may have written above it — but it turns the case that
   * actually happens (a caller numbering from a stale log) into a clean
   * conflict.
   */
  highestWritten(runId: string): Promise<number>;
  /**
   * Forgets a reserved or claimed slot whose publish is never going to happen,
   * so nothing waits on it.
   *
   * The position is handed out again only if it is still the highest one this
   * book knows of, where it provably sits below nothing. Anywhere else it stays
   * empty: it may already sit below a sibling that published, and recycling it
   * there would put a later event below an earlier one.
   */
  release(runId: string, slot: number): void;
  /** Records a published event id, so it is never handed out again. */
  observe(runId: string, eventId: string): void;
  /**
   * Merges the run's published positions from disk into the book kept for it,
   * leaving the reservations other writers in this instance still hold.
   *
   * A writer whose publish lost its position calls this before trying again:
   * the book is demonstrably behind another instance's writes, and dropping it
   * wholesale ({@link SlotBook.forget}) would hand a sibling's outstanding
   * position to the next caller and cost that sibling its own publish.
   */
  refresh(runId: string): Promise<void>;
  /** Drops what is cached for `runId`, so the next reservation re-reads disk. */
  forget(runId: string): void;
  /** Drops everything cached (the data directory was cleared out from under us). */
  clear(): void;
}

export function createSlotBook(basedir: string, tag?: string): SlotBook {
  /** runId → whether the run is slot-numbered, memoized once it exists. */
  const modes = new Map<string, boolean>();
  const books = new Map<string, RunSlots>();
  /** runId → in-flight seed scan, so concurrent first callers share one scan. */
  const seeds = new Map<string, Promise<RunSlots>>();
  /** runId → in-flight tail read, so a burst of writers shares one scan. */
  const syncs = new Map<string, Promise<RunSlots>>();
  /**
   * runId → slots claimed while the run had no book yet, so the book the next
   * allocation seeds starts out holding them. A claim is synchronous and a seed
   * scan is not: without this, the first allocation of a run would read the log
   * from disk and hand out a position a caller in this very instance had already
   * claimed — the case that makes a claim lose in a single-process app.
   */
  const claims = new Map<string, Set<number>>();

  async function readMode(runId: string): Promise<boolean> {
    const run = await readJSONWithFallback<WorkflowRun>(
      basedir,
      'runs',
      runId,
      WorkflowRunSchema,
      tag
    );
    return run ? usesSlotIdentity(run.specVersion) : false;
  }

  async function seed(runId: string): Promise<RunSlots> {
    const eventIds = await listRunEventIds(basedir, runId, tag);
    const written = new Set<number>();
    for (const eventId of eventIds) {
      const slot = slotFromId(eventId);
      if (slot !== undefined) {
        written.add(slot);
      }
    }
    const outstanding = new Set(claims.get(runId));
    const book: RunSlots = {
      written,
      outstanding,
      ceiling: Math.max(FIRST_SLOT - 1, ...written, ...outstanding),
    };
    books.set(runId, book);
    return book;
  }

  /** Folds the run's published positions on disk into the book kept for it. */
  async function merge(runId: string, book: RunSlots): Promise<RunSlots> {
    for (const eventId of await listRunEventIds(basedir, runId, tag)) {
      const slot = slotFromId(eventId);
      if (slot !== undefined) {
        book.written.add(slot);
        book.outstanding.delete(slot);
        book.ceiling = Math.max(book.ceiling, slot);
      }
    }
    return book;
  }

  /**
   * The run's book with the log's current tail folded in.
   *
   * Every allocation and every tail read goes through this, because the book on
   * its own only knows what *this* instance did: another instance sharing the
   * data directory publishes without touching it. One scan is shared by all
   * callers waiting on it, so a burst of concurrent writers pays for one readdir
   * and still leaves with distinct positions (the scan resolves first, the
   * synchronous takes follow).
   */
  function synced(runId: string): Promise<RunSlots> {
    const inFlight = syncs.get(runId);
    if (inFlight) {
      return inFlight;
    }
    // Seeding reads the log itself, so a book being opened for the first time is
    // already current and a second scan would buy nothing.
    const seeding = !books.has(runId);
    const opened = open(runId);
    const scan =
      seeding && opened instanceof Promise
        ? opened
        : Promise.resolve(opened).then((book) => merge(runId, book));
    const pending = scan.finally(() => syncs.delete(runId));
    syncs.set(runId, pending);
    return pending;
  }

  /** The run's book, seeding it from disk once for all concurrent callers. */
  function open(runId: string): RunSlots | Promise<RunSlots> {
    const known = books.get(runId);
    if (known) {
      return known;
    }
    let pending = seeds.get(runId);
    if (!pending) {
      pending = seed(runId).finally(() => seeds.delete(runId));
      seeds.set(runId, pending);
    }
    return pending;
  }

  /**
   * Drops a claim once its publish resolved, either way: a claim left behind
   * would be handed to no one and become a hole in a log seeded later.
   */
  function forgetClaim(runId: string, slot: number): void {
    const claimed = claims.get(runId);
    if (!claimed) {
      return;
    }
    claimed.delete(slot);
    if (claimed.size === 0) {
      claims.delete(runId);
    }
  }

  function take(book: RunSlots, minSlot: number): number {
    const slot = Math.max(book.ceiling + 1, minSlot);
    book.outstanding.add(slot);
    book.ceiling = slot;
    return slot;
  }

  return {
    async usesSlots(runId) {
      const cached = modes.get(runId);
      if (cached !== undefined) {
        return cached;
      }
      const mode = await readMode(runId);
      // `false` here can mean "run not created yet" as well as "ULID run", and
      // only the run's own absence is transient — so remember the positive
      // answer eagerly and re-read until the run exists.
      if (mode) {
        modes.set(runId, true);
      }
      return mode;
    },

    async reserve(runId, minSlot = RUN_CREATED_SLOT + 1) {
      // The take is synchronous once the scan resolves, so two concurrent
      // callers sharing one scan still leave with different positions.
      return take(await synced(runId), minSlot);
    },

    claim(runId, slot) {
      const claimed = claims.get(runId);
      if (claimed) {
        claimed.add(slot);
      } else {
        claims.set(runId, new Set([slot]));
      }
      const book = books.get(runId);
      if (book) {
        book.outstanding.add(slot);
        book.ceiling = Math.max(book.ceiling, slot);
      }
    },

    async highestWritten(runId) {
      const book = await synced(runId);
      return Math.max(FIRST_SLOT - 1, ...book.written);
    },

    release(runId, slot) {
      forgetClaim(runId, slot);
      const book = books.get(runId);
      if (!book) {
        return;
      }
      book.outstanding.delete(slot);
      // The position is handed out again only while it is still the top of the
      // book: nothing was handed out above it and nothing was read from disk
      // above it, so it cannot land below an event that already exists. Below
      // the top the ceiling stays where it is, and the position stays a hole.
      if (book.ceiling === slot) {
        book.ceiling = Math.max(
          FIRST_SLOT - 1,
          ...book.written,
          ...book.outstanding
        );
      }
    },

    observe(runId, eventId) {
      const slot = slotFromId(eventId);
      if (slot === undefined) {
        return;
      }
      forgetClaim(runId, slot);
      const book = books.get(runId);
      if (!book) {
        // Nothing to keep consistent: the slot is on disk by the time this is
        // called, so the eventual seed scan picks it up.
        return;
      }
      book.written.add(slot);
      book.outstanding.delete(slot);
      book.ceiling = Math.max(book.ceiling, slot);
    },

    async refresh(runId) {
      const book = books.get(runId);
      if (!book) {
        // Nothing cached to correct; the next reservation seeds from disk.
        return;
      }
      await merge(runId, book);
    },

    forget(runId) {
      modes.delete(runId);
      books.delete(runId);
      // Claims outlive the book on purpose: they belong to writes still in
      // flight, and the book a later allocation seeds has to hold them back.
    },

    clear() {
      modes.clear();
      books.clear();
      claims.clear();
    },
  };
}

/**
 * The slot a run's first event occupies. A run's own `run_created` is the only
 * event that can be numbered without consulting the log, because there is
 * provably nothing before it.
 */
export const RUN_CREATED_SLOT = FIRST_SLOT;
