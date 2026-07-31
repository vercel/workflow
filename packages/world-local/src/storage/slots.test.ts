import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
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
  it('starts above the slot the run’s own creation event owns', async () => {
    // `run_created` takes the first slot outright — nothing can precede it — so
    // an allocation never hands that position out.
    await expect(createSlotBook(basedir).reserve(RUN_ID)).resolves.toBe(
      RUN_CREATED_SLOT + 1
    );
  });

  it('continues above the highest slot already on disk', async () => {
    await writeEvents(1, 2, 3);
    await expect(createSlotBook(basedir).reserve(RUN_ID)).resolves.toBe(4);
  });

  it('leaves a hole in the persisted log unfilled', async () => {
    // Allocation is append-only: the free position sits below a published event,
    // and an event placed there would order before one that already happened.
    await writeEvents(1, 3);
    const book = createSlotBook(basedir);
    await expect(book.reserve(RUN_ID)).resolves.toBe(4);
    await expect(book.reserve(RUN_ID)).resolves.toBe(5);
  });

  it('stays above published events when a lower position comes free', async () => {
    // The corruption this rules out: a step completion allocating late, dropping
    // into a hole, and landing below the step_started it reports on. Replay reads
    // the log in slot order and cannot consume that.
    const book = createSlotBook(basedir);
    const abandoned = await book.reserve(RUN_ID);
    const published = await book.reserve(RUN_ID);
    book.observe(RUN_ID, slotEventId(published));
    book.release(RUN_ID, abandoned);
    await expect(book.reserve(RUN_ID)).resolves.toBeGreaterThan(published);
  });

  it('hands a synchronous burst distinct consecutive slots', async () => {
    // The suspension flush issues every op concurrently; a book that only moved
    // on publish would give them all the same position and fail all but one.
    const book = createSlotBook(basedir);
    const slots = await Promise.all(
      Array.from({ length: 20 }, () => book.reserve(RUN_ID))
    );
    expect([...slots].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => RUN_CREATED_SLOT + 1 + index)
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

  it('honours a floor above where the book has reached', async () => {
    // start() publishes the run entity before its `run_created` event and issues
    // the queue send in parallel, so the delivery's `run_started` can allocate
    // while slot 1 is still in flight.
    const book = createSlotBook(basedir);
    await expect(book.reserve(RUN_ID, 5)).resolves.toBe(5);
    await expect(book.reserve(RUN_ID)).resolves.toBe(6);
  });

  it('keeps runs independent', async () => {
    await writeEvents(1, 2);
    const book = createSlotBook(basedir);
    await expect(book.reserve(RUN_ID)).resolves.toBe(3);
    await expect(book.reserve('wrun_01K0000000000000000000OTHR')).resolves.toBe(
      RUN_CREATED_SLOT + 1
    );
  });
});

describe('release', () => {
  it('does not recycle an abandoned interior slot', async () => {
    // The position may already sit below a sibling that published, and no
    // caller can tell from here. A hole is a position nothing ever wrote; an
    // inversion is an event a replay reads before the one it followed.
    const book = createSlotBook(basedir);
    const [first, second] = await Promise.all([
      book.reserve(RUN_ID),
      book.reserve(RUN_ID),
    ]);
    book.release(RUN_ID, first);
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

  it('stops holding back a claim that resolved', async () => {
    // Released before anything allocated for the run, so no position in this
    // instance was ever handed out above it and the log — which is the authority
    // on what published — reaches only slot 1. Nothing can be inverted by
    // seeding the book from disk alone.
    await writeEvents(1);
    const book = createSlotBook(basedir);
    book.claim(RUN_ID, 2);
    book.release(RUN_ID, 2);
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
  it('moves allocation above a position the client claimed', async () => {
    const book = createSlotBook(basedir);
    await book.reserve(RUN_ID);
    book.observe(RUN_ID, slotEventId(5));
    await expect(book.reserve(RUN_ID)).resolves.toBe(6);
  });

  it('ignores ULID event ids', async () => {
    const book = createSlotBook(basedir);
    const slot = await book.reserve(RUN_ID);
    book.observe(RUN_ID, 'evnt_01K5Z0000000000000000000AA');
    await expect(book.reserve(RUN_ID)).resolves.toBe(slot + 1);
  });
});

describe('forget', () => {
  it("re-reads the log, picking up another writer's events", async () => {
    const book = createSlotBook(basedir);
    await expect(book.reserve(RUN_ID)).resolves.toBe(RUN_CREATED_SLOT + 1);
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
