import type { CreateEventRequest } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  CREATION_EVENT_META_ALLOWANCE_BYTES,
  MAX_BATCH_EVENTS,
  MAX_IN_BAND_CREATION_BATCH_BYTES,
  MAX_IN_BAND_CREATION_BATCH_EVENTS,
} from '../constants.js';
import { batchChunks, creationBatchBytes } from './step-wait-creation.js';

const created = (id: string) =>
  ({ eventType: 'step_created', correlationId: id }) as CreateEventRequest;
const createdByStart = (id: string) =>
  ({
    eventType: 'step_started',
    correlationId: id,
    eventData: { inline: true },
  }) as CreateEventRequest;

/**
 * `inline` creation-bearing starts, then `background` plain creations, as a
 * suspension plans them.
 */
function fanOut(inline: number, background: number): CreateEventRequest[] {
  const events: CreateEventRequest[] = [];
  for (let i = 0; i < inline; i++) events.push(createdByStart(`i${i}`));
  for (let i = 0; i < background; i++) events.push(created(`b${i}`));
  return events;
}

describe('batchChunks', () => {
  it('keeps a suspension that fits one batch in one batch', () => {
    const events = fanOut(3, MAX_BATCH_EVENTS - 3);
    expect(batchChunks(events)).toEqual([events]);
  });

  // The inline starts share the first batch with background creations, so
  // the background creations do not wait one more round trip behind a batch
  // of only the inline starts.
  it('puts the inline creations of a wider fan-out in the first batch, with background creations', () => {
    const events = fanOut(3, 97);
    const chunks = batchChunks(events);
    expect(chunks[0]).toEqual(
      events.slice(0, MAX_IN_BAND_CREATION_BATCH_EVENTS)
    );
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(
        MAX_IN_BAND_CREATION_BATCH_EVENTS
      );
    }
    // Order and content are kept.
    expect(chunks.flat()).toEqual(events);
  });

  // Each batch is a round trip the next one waits on, so a fan-out's
  // background creations go out in the fewest batches that fit.
  it('writes a fan-out that fits one batch, inline starts included, in one round trip', () => {
    const events = fanOut(3, MAX_IN_BAND_CREATION_BATCH_EVENTS - 3);
    expect(batchChunks(events)).toEqual([events]);
  });

  it('writes a fan-out one past a full batch in two round trips', () => {
    const events = fanOut(3, MAX_IN_BAND_CREATION_BATCH_EVENTS - 2);
    expect(batchChunks(events)).toEqual([
      events.slice(0, MAX_IN_BAND_CREATION_BATCH_EVENTS),
      events.slice(MAX_IN_BAND_CREATION_BATCH_EVENTS),
    ]);
  });

  it('starts a new background batch past the event ceiling', () => {
    const background = 2 * MAX_IN_BAND_CREATION_BATCH_EVENTS + 1;
    const chunks = batchChunks(fanOut(0, background));
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      MAX_IN_BAND_CREATION_BATCH_EVENTS,
      MAX_IN_BAND_CREATION_BATCH_EVENTS,
      1,
    ]);
  });

  it('keeps every batch within the byte ceiling', () => {
    // Inputs large enough that the event ceiling alone would overflow it.
    const inputBytes = Math.ceil(
      MAX_IN_BAND_CREATION_BATCH_BYTES / MAX_IN_BAND_CREATION_BATCH_EVENTS
    );
    const events = fanOut(0, MAX_IN_BAND_CREATION_BATCH_EVENTS).map(
      (event) =>
        ({
          ...event,
          eventData: { input: new Uint8Array(inputBytes) },
        }) as CreateEventRequest
    );
    expect(creationBatchBytes(events[0]!)).toBe(
      inputBytes + CREATION_EVENT_META_ALLOWANCE_BYTES
    );
    const chunks = batchChunks(events);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const bytes = chunk.reduce((sum, e) => sum + creationBatchBytes(e), 0);
      expect(bytes).toBeLessThanOrEqual(MAX_IN_BAND_CREATION_BATCH_BYTES);
    }
    expect(chunks.flat()).toEqual(events);
  });

  it('sends a creation larger than the byte ceiling in a batch of its own', () => {
    const huge = {
      ...created('huge'),
      eventData: { input: new Uint8Array(MAX_IN_BAND_CREATION_BATCH_BYTES) },
    } as CreateEventRequest;
    const events = [created('a'), huge, created('b')];
    expect(batchChunks(events)).toEqual([[events[0]], [huge], [events[2]]]);
  });

  it('keeps every inline creation ahead of every background creation', () => {
    const inline = MAX_BATCH_EVENTS + 1;
    const events = fanOut(inline, MAX_IN_BAND_CREATION_BATCH_EVENTS);
    const chunks = batchChunks(events);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(
        MAX_IN_BAND_CREATION_BATCH_EVENTS
      );
    }
    expect(chunks.flat()).toEqual(events);
    // Every inline start is in the first batch.
    expect(
      chunks[0]?.filter((e) => e.eventType === 'step_started')
    ).toHaveLength(inline);
  });
});
