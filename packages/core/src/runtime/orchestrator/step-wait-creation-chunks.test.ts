import type { CreateEventRequest } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { MAX_BATCH_EVENTS } from '../constants.js';
import { batchChunks } from './step-wait-creation.js';

const created = (id: string) =>
  ({ eventType: 'step_created', correlationId: id }) as CreateEventRequest;
const started = (id: string) =>
  ({ eventType: 'step_started', correlationId: id }) as CreateEventRequest;

/** `inline` created+started pairs, then `background` plain creations. */
function fanOut(inline: number, background: number): CreateEventRequest[] {
  const events: CreateEventRequest[] = [];
  for (let i = 0; i < inline; i++)
    events.push(created(`i${i}`), started(`i${i}`));
  for (let i = 0; i < background; i++) events.push(created(`b${i}`));
  return events;
}

describe('batchChunks', () => {
  it('keeps a suspension that fits one batch in one batch', () => {
    const events = fanOut(3, MAX_BATCH_EVENTS - 6);
    expect(batchChunks(events)).toEqual([events]);
  });

  it('puts the inline pairs of a wider fan-out in a batch of their own', () => {
    const events = fanOut(3, 97);
    const chunks = batchChunks(events);
    expect(chunks[0]).toEqual(events.slice(0, 6));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_BATCH_EVENTS);
    }
    // Order and content are kept.
    expect(chunks.flat()).toEqual(events);
  });

  it('never splits a pair across batches', () => {
    const inline = MAX_BATCH_EVENTS / 2 + 1;
    const chunks = batchChunks(fanOut(inline, 10));
    for (const chunk of chunks) {
      const first = chunk[0];
      expect(first?.eventType).not.toBe('step_started');
    }
    // The pairs fill their own batches before any plain creation.
    const firstPlain = chunks.findIndex((chunk) =>
      chunk.some((e) => e.correlationId?.startsWith('b'))
    );
    expect(
      chunks
        .slice(0, firstPlain)
        .flat()
        .every((e) => e.correlationId?.startsWith('i'))
    ).toBe(true);
  });
});
