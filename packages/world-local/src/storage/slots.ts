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
 * by an abandoned reservation sits below events that are already published. Hand
 * it to the next caller and a `step_completed` lands below its own
 * `step_started`; the replay reaches a completion for a step it has not started
 * and diverges, and every later replay diverges the same way. A hole costs a
 * reader the ability to prove its copy of the log is complete. An inversion
 * costs the run.
 *
 * Three properties do the work:
 *
 *   - Handing out a slot is a *synchronous* set operation, so concurrent
 *     callers in one process get distinct slots with no lock. The only await is
 *     seeding from disk, which is memoized per run.
 *   - An allocation picks the position above the highest one the book knows of,
 *     written or outstanding, and that ceiling never descends. A reservation that
 *     is abandoned (its create threw a validation error) leaves its position
 *     unused rather than being recycled below a sibling that already published.
 *   - The event publish is `writeExclusive`, which is the authority. The book is
 *     a hint: when it turns out to be stale (another process wrote the slot),
 *     the publish fails and the caller is told so, rather than a duplicate being
 *     written or a slot being skipped.
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
   * Reserves the position above every one this book knows of for `runId`, and at
   * or above `minSlot`. Distinct for every concurrent caller; the publish still
   * has to prove the position was actually free.
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
   * Whether `slot` is already occupied by a published event, seeding from disk
   * if this run has not been read yet.
   *
   * Lets a doomed claim be rejected *before* the create materializes its step,
   * hook or wait: the entity mutation runs ahead of the event publish, so a
   * claim that only fails at the publish leaves an entity behind with no event,
   * and the caller's re-proposal at the next slot then collides with its own
   * orphan. A `false` here is not a promise — the publish is still the
   * authority — but it turns the case that actually happens (a caller numbering
   * from a stale log) into a clean conflict.
   */
  isWritten(runId: string, slot: number): Promise<boolean>;
  /**
   * Forgets a reserved or claimed slot whose publish is never going to happen,
   * so nothing waits on it. The position itself is not handed out again: it may
   * already sit below a sibling that published, and recycling it there would put
   * a later event below an earlier one.
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
      const opened = open(runId);
      // Awaiting a book that is already in hand would yield to the microtask
      // queue and let a concurrent caller take the same slot.
      return take(opened instanceof Promise ? await opened : opened, minSlot);
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

    async isWritten(runId, slot) {
      const book = await open(runId);
      return book.written.has(slot);
    },

    release(runId, slot) {
      forgetClaim(runId, slot);
      const book = books.get(runId);
      if (!book) {
        return;
      }
      // The ceiling stays where it is: this position may already sit below one a
      // sibling published, and handing it out again would order a later event
      // before an earlier one.
      book.outstanding.delete(slot);
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
      for (const eventId of await listRunEventIds(basedir, runId, tag)) {
        const slot = slotFromId(eventId);
        if (slot !== undefined) {
          book.written.add(slot);
          book.outstanding.delete(slot);
          book.ceiling = Math.max(book.ceiling, slot);
        }
      }
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
