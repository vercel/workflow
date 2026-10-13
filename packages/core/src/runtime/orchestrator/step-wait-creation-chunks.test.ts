import type { CreateEventRequest } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { MAX_BATCH_EVENTS } from '../constants.js';
import { batchChunks } from './step-wait-creation.js';

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

  it('puts the inline creations of a wider fan-out in a batch of their own', () => {
    const events = fanOut(3, 97);
    const chunks = batchChunks(events);
    expect(chunks[0]).toEqual(events.slice(0, 3));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_BATCH_EVENTS);
    }
    // Order and content are kept.
    expect(chunks.flat()).toEqual(events);
  });

  it('fills batches with inline creations before any background creation', () => {
    const inline = MAX_BATCH_EVENTS + 1;
    const chunks = batchChunks(fanOut(inline, 10));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_BATCH_EVENTS);
    }
    const firstPlain = chunks.findIndex((chunk) =>
      chunk.some((e) => e.correlationId?.startsWith('b'))
    );
    expect(
      chunks
        .slice(0, firstPlain)
        .flat()
        .every((e) => e.correlationId?.startsWith('i'))
    ).toBe(true);
    expect(
      chunks[firstPlain]?.every((e) => e.eventType === 'step_created')
    ).toBe(true);
  });
});
