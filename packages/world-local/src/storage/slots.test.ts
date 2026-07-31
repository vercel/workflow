import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FIRST_SLOT,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SLOT_IDENTITY,
  slotEventId,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSlotBook, RUN_CREATED_SLOT } from './slots.js';

let basedir: string;

beforeEach(async () => {
  basedir = await fs.mkdtemp(path.join(os.tmpdir(), 'slot-book-'));
});

afterEach(async () => {
  await fs.rm(basedir, { recursive: true, force: true });
});

const RUN_ID = 'wrun_01K0000000000000000000TEST';

async function writeRun(specVersion: number): Promise<void> {
  await fs.mkdir(path.join(basedir, 'runs'), { recursive: true });
  await fs.writeFile(
    path.join(basedir, 'runs', `${RUN_ID}.json`),
    JSON.stringify({
      runId: RUN_ID,
      deploymentId: 'dpl_test',
      status: 'running',
      workflowName: 'test',
      specVersion,
      input: [],
      attributes: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );
}

async function writeEvents(...slots: number[]): Promise<void> {
  await fs.mkdir(path.join(basedir, 'events'), { recursive: true });
  for (const slot of slots) {
    await fs.writeFile(
      path.join(basedir, 'events', `${RUN_ID}-${slotEventId(slot)}.json`),
      '{}'
    );
  }
}

describe('usesSlots', () => {
  it('reads the mode off the persisted run, not the build', async () => {
    await writeRun(SPEC_VERSION_SLOT_IDENTITY);
    await expect(createSlotBook(basedir).usesSlots(RUN_ID)).resolves.toBe(true);

    await writeRun(SPEC_VERSION_CURRENT);
    await expect(createSlotBook(basedir).usesSlots(RUN_ID)).resolves.toBe(
      false
    );
  });

  it('re-reads until the run exists', async () => {
    // The resilient-start path writes run_started before the run entity, so a
    // cached "no" taken from the missing run would strand a slot-numbered run
    // on ULID ids for the rest of the process's life.
    const book = createSlotBook(basedir);
    await expect(book.usesSlots(RUN_ID)).resolves.toBe(false);
    await writeRun(SPEC_VERSION_SLOT_IDENTITY);
    await expect(book.usesSlots(RUN_ID)).resolves.toBe(true);
  });

  it('prefers its own tagged run over the untagged one', async () => {
    await writeRun(SPEC_VERSION_SLOT_IDENTITY);
    await fs.rename(
      path.join(basedir, 'runs', `${RUN_ID}.json`),
      path.join(basedir, 'runs', `${RUN_ID}.mine.json`)
    );
    await writeRun(SPEC_VERSION_CURRENT);

    await expect(
      createSlotBook(basedir, 'mine').usesSlots(RUN_ID)
    ).resolves.toBe(true);
    await expect(
      createSlotBook(basedir, 'other').usesSlots(RUN_ID)
    ).resolves.toBe(false);
  });
});

describe('reserve', () => {
  it('starts at the first slot for a run with no events', async () => {
    await expect(createSlotBook(basedir).reserve(RUN_ID)).resolves.toBe(
      FIRST_SLOT
    );
  });

  it('continues above the highest slot already on disk', async () => {
    await writeEvents(1, 2, 3);
    await expect(createSlotBook(basedir).reserve(RUN_ID)).resolves.toBe(4);
  });

  it('fills a hole left in the persisted log', async () => {
    // Density is the whole point of the scheme, so a gap that somehow exists is
    // reclaimed rather than skipped over forever.
    await writeEvents(1, 3);
    const book = createSlotBook(basedir);
    await expect(book.reserve(RUN_ID)).resolves.toBe(2);
    await expect(book.reserve(RUN_ID)).resolves.toBe(4);
  });

  it('hands a synchronous burst distinct consecutive slots', async () => {
    // The suspension flush issues every op concurrently; with a plain
    // "max + 1" they would all pick the same slot and all but one would fail.
    const book = createSlotBook(basedir);
    const slots = await Promise.all(
      Array.from({ length: 20 }, () => book.reserve(RUN_ID))
    );
    expect([...slots].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => FIRST_SLOT + index)
    );
  });

  it('shares one disk scan across concurrent first callers', async () => {
    await writeEvents(1);
    const book = createSlotBook(basedir);
    const slots = await Promise.all([
      book.reserve(RUN_ID),
      book.reserve(RUN_ID),
    ]);
    expect([...slots].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('honours a floor, so a concurrent event cannot take run_created’s slot', async () => {
    // start() publishes the run entity before its `run_created` event and
    // issues the queue send in parallel, so the delivery's `run_started` can
    // allocate while slot 1 is still in flight.
    const book = createSlotBook(basedir);
    await expect(book.reserve(RUN_ID, RUN_CREATED_SLOT + 1)).resolves.toBe(
      RUN_CREATED_SLOT + 1
    );
  });

  it('leaves slots below the floor allocatable', async () => {
    // A floored search skips that range without looking at it, so it proves
    // nothing about it — `run_created` must still find its own slot free.
    const book = createSlotBook(basedir);
    await expect(book.reserve(RUN_ID, RUN_CREATED_SLOT + 1)).resolves.toBe(
      RUN_CREATED_SLOT + 1
    );
    await expect(book.reserve(RUN_ID, RUN_CREATED_SLOT)).resolves.toBe(
      RUN_CREATED_SLOT
    );
  });

  it('keeps runs independent', async () => {
    await writeEvents(1, 2);
    const book = createSlotBook(basedir);
    await expect(book.reserve(RUN_ID)).resolves.toBe(3);
    await expect(book.reserve('wrun_01K0000000000000000000OTHR')).resolves.toBe(
      FIRST_SLOT
    );
  });
});

describe('release', () => {
  it('gives an abandoned interior slot to the next caller', async () => {
    // A rejected op must not strand the slot below its concurrent siblings':
    // that hole can never be filled once a later slot is published.
    const book = createSlotBook(basedir);
    const [first, second] = await Promise.all([
      book.reserve(RUN_ID),
      book.reserve(RUN_ID),
    ]);
    book.release(RUN_ID, first);
    await expect(book.reserve(RUN_ID)).resolves.toBe(first);
    await expect(book.reserve(RUN_ID)).resolves.toBe(second + 1);
  });

  it('does not resurrect a slot that was published', async () => {
    const book = createSlotBook(basedir);
    const slot = await book.reserve(RUN_ID);
    book.observe(RUN_ID, slotEventId(slot));
    book.release(RUN_ID, slot);
    await expect(book.reserve(RUN_ID)).resolves.toBe(slot + 1);
  });
});

describe('isWritten', () => {
  it('reads the log to answer for a run it has never seen', async () => {
    await writeEvents(1, 2);
    const book = createSlotBook(basedir);
    await expect(book.isWritten(RUN_ID, 2)).resolves.toBe(true);
    await expect(book.isWritten(RUN_ID, 3)).resolves.toBe(false);
  });

  it('is false for a slot that is only reserved', async () => {
    // A reservation is not a publish, so a caller claiming the slot has to be
    // allowed through to the write that actually decides it.
    const book = createSlotBook(basedir);
    const slot = await book.reserve(RUN_ID);
    await expect(book.isWritten(RUN_ID, slot)).resolves.toBe(false);
  });
});

describe('claim', () => {
  it('holds a slot claimed before anything allocated for the run', async () => {
    // A claim is synchronous and the first allocation's log scan is not, so a
    // claim that only registered against an existing book would be invisible to
    // the very allocation it races — and a single-process app would hand the
    // caller's own position away.
    await writeEvents(1);
    const book = createSlotBook(basedir);
    book.claim(RUN_ID, 2);
    await expect(book.reserve(RUN_ID)).resolves.toBe(3);
  });

  it('frees the slot again once the claim resolves', async () => {
    await writeEvents(1);
    const book = createSlotBook(basedir);
    book.claim(RUN_ID, 2);
    book.release(RUN_ID, 2);
    // Nothing is allocating for the run yet, so the book the next caller seeds
    // has to start from the log alone.
    await expect(book.reserve(RUN_ID)).resolves.toBe(2);
  });

  it('keeps holding a claim across a forget', async () => {
    // `forget` follows a lost publish: the book is behind another writer, but
    // the claims other writes in this instance still hold are not.
    await writeEvents(1);
    const book = createSlotBook(basedir);
    book.claim(RUN_ID, 2);
    book.forget(RUN_ID);
    await expect(book.reserve(RUN_ID)).resolves.toBe(3);
  });
});

describe('observe', () => {
  it('never hands out a slot claimed by the client', async () => {
    const book = createSlotBook(basedir);
    await book.reserve(RUN_ID);
    book.observe(RUN_ID, slotEventId(5));
    const next = await book.reserve(RUN_ID);
    expect(next).not.toBe(5);
    expect(next).toBe(2);
  });

  it('ignores ULID event ids', async () => {
    const book = createSlotBook(basedir);
    await book.reserve(RUN_ID);
    book.observe(RUN_ID, 'evnt_01K5Z0000000000000000000AA');
    await expect(book.reserve(RUN_ID)).resolves.toBe(2);
  });
});

describe('forget', () => {
  it("re-reads the log, picking up another writer's events", async () => {
    const book = createSlotBook(basedir);
    await expect(book.reserve(RUN_ID)).resolves.toBe(FIRST_SLOT);
    await writeEvents(1, 2, 3);
    book.forget(RUN_ID);
    await expect(book.reserve(RUN_ID)).resolves.toBe(4);
  });

  it('clear() forgets every run', async () => {
    await writeEvents(1);
    const book = createSlotBook(basedir);
    await expect(book.reserve(RUN_ID)).resolves.toBe(2);
    await writeEvents(2, 3);
    book.clear();
    await expect(book.reserve(RUN_ID)).resolves.toBe(4);
  });
});
