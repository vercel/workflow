import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDeliveryHandler, createRunGate } from '../src/queue-handler.js';
import {
  CONCURRENCY_CASES,
  REQUEST_CASES,
  runCases,
} from './__fixtures__/queue-handler/cases.mjs';

/**
 * The Postgres World's delivery handler answers exactly as the handler it
 * replaced (`@workflow/world-local`'s `createQueueHandler`), case for case:
 * `expected.json` was recorded from that handler by
 * `__fixtures__/queue-handler/record.mjs`, and these tests replay the same
 * requests against the Postgres handler. A difference is a behavior change,
 * which this handler is not meant to carry.
 */
describe('Postgres delivery handler parity with the handler it replaced', async () => {
  const { results: expected } = JSON.parse(
    await readFile(
      new URL('./__fixtures__/queue-handler/expected.json', import.meta.url),
      'utf8'
    )
  ) as { results: Record<string, unknown> };

  // The same JSON transport the queue uses (see `createQueue`).
  async function deserialize(stream: ReadableStream<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString(), (_key, v) =>
      v !== null &&
      typeof v === 'object' &&
      v.__type === 'Uint8Array' &&
      typeof v.data === 'string'
        ? new Uint8Array(Buffer.from(v.data, 'base64'))
        : v
    );
  }

  const runGate = createRunGate();
  const actual = await runCases((prefix, handler) =>
    createDeliveryHandler(prefix, handler, { runGate, deserialize })
  );

  it('covers every recorded case', () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    expect(Object.keys(expected)).toHaveLength(
      REQUEST_CASES.length + CONCURRENCY_CASES.length
    );
  });

  it.each(REQUEST_CASES.map((c) => c.name))('%s', (name) => {
    expect(actual[name]).toEqual(expected[name]);
  });

  it.each(CONCURRENCY_CASES.map((c) => c.name))('%s', (name) => {
    expect(actual[name]).toEqual(expected[name]);
  });

  it('releases the run gate after every delivery', () => {
    expect(runGate.size()).toBe(0);
  });
});
