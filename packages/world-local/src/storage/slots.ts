/**
 * Slot allocation for the Local World.
 *
 * A slot-numbered run names its events by position: `evnt_…001` is the first
 * event of the run, `evnt_…002` the second, with no gaps. Density is the point
 * — it is what lets a reader prove its loaded log is complete — so an allocator
 * must never leave a slot permanently unwritten.
 *
 * Three properties do the work:
 *
 *   - Handing out a slot is a *synchronous* set operation, so concurrent
 *     callers in one process get distinct slots with no lock. The only await is
 *     seeding from disk, which is memoized per run.
 *   - An allocation always picks the lowest slot that is neither written nor
 *     outstanding, so a reservation that is abandoned (its create threw a
 *     validation error) is handed to the next caller instead of leaving an
 *     interior hole. This matters under fan-out: N concurrent step_completed
 *     writes reserve N consecutive slots, and one rejected op must not strand
 *     the slot below its siblings'.
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
  /** Lowest slot that might still be free; never decreases except on release. */
  searchFrom: number;
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
   * Reserves the lowest free slot of `runId`, at or above `minSlot`. Distinct
   * for every concurrent caller; the publish still has to prove the slot was
   * actually free.
   *
   * `minSlot` is how the run's first slot is kept for its own `run_created`:
   * that event's slot needs no allocation, and it may not be on disk yet when a
   * concurrent `run_started` allocates (start() issues the creation and the
   * queue send in parallel, and the run entity is published before its event).
   * Slots below `minSlot` stay allocatable for a later caller, so holding one
   * back leaves the log dense.
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
   * Returns a reserved or claimed slot that was never published, so the next
   * caller takes it instead of it becoming a hole.
   */
  release(runId: string, slot: number): void;
  /** Records a published event id, so it is never handed out again. */
  observe(runId: string, eventId: string): void;
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
    const book: RunSlots = {
      written,
      outstanding: new Set(),
      searchFrom: FIRST_SLOT,
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

  function take(book: RunSlots, minSlot: number): number {
    let slot = Math.max(book.searchFrom, minSlot);
    while (book.written.has(slot) || book.outstanding.has(slot)) {
      slot += 1;
    }
    book.outstanding.add(slot);
    if (minSlot <= book.searchFrom) {
      // Only an unfloored search proves everything below the slot it landed on
      // is taken. A floored one skipped that range without looking, and those
      // slots are still free for a caller that may take them.
      book.searchFrom = slot;
    }
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

    async reserve(runId, minSlot = FIRST_SLOT) {
      const opened = open(runId);
      // Awaiting a book that is already in hand would yield to the microtask
      // queue and let a concurrent caller take the same slot.
      return take(opened instanceof Promise ? await opened : opened, minSlot);
    },

    claim(runId, slot) {
      // No book means nothing is allocating for this run in this instance yet,
      // and the seed scan that starts one reads the claim off disk if it landed.
      books.get(runId)?.outstanding.add(slot);
    },

    async isWritten(runId, slot) {
      const book = await open(runId);
      return book.written.has(slot);
    },

    release(runId, slot) {
      const book = books.get(runId);
      if (!book) {
        return;
      }
      book.outstanding.delete(slot);
      if (slot < book.searchFrom) {
        book.searchFrom = slot;
      }
    },

    observe(runId, eventId) {
      const book = books.get(runId);
      if (!book) {
        // Nothing to keep consistent: the slot is on disk by the time this is
        // called, so the eventual seed scan picks it up.
        return;
      }
      const slot = slotFromId(eventId);
      if (slot === undefined) {
        return;
      }
      book.written.add(slot);
      book.outstanding.delete(slot);
    },

    forget(runId) {
      modes.delete(runId);
      books.delete(runId);
    },

    clear() {
      modes.clear();
      books.clear();
    },
  };
}

/**
 * The slot a run's first event occupies. A run's own `run_created` is the only
 * event that can be numbered without consulting the log, because there is
 * provably nothing before it.
 */
export const RUN_CREATED_SLOT = FIRST_SLOT;
