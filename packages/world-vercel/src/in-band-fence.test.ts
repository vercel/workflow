import {
  IN_BAND_SUPERSEDED_CODE,
  InBandSupersededError,
  PreconditionFailedError,
} from '@workflow/errors';
import { decode, encode } from 'cbor-x';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflowRunEvent,
  createWorkflowRunEventBatch,
} from './events.js';
import { throwForErrorResponse } from './events-v4.js';
import { errorForResponse, recordInBandRefusal } from './http-core.js';

vi.mock('./get-deadline.js', () => ({
  getDeadline: vi.fn(async () => undefined),
}));

const config = { token: 'test-token', dispatcher: {} };

/** The frame metas of a v4 POST body: `[u32 metaLen][meta][u32 bodyLen][body]`*. */
function frameMetas(body: unknown): Record<string, unknown>[] {
  const bytes =
    body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBufferLike);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metas: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const metaLen = view.getUint32(offset, false);
    offset += 4;
    metas.push(
      decode(bytes.subarray(offset, offset + metaLen)) as Record<
        string,
        unknown
      >
    );
    offset += metaLen;
    offset += 4 + view.getUint32(offset, false);
  }
  return metas;
}

function supersededResponse(): Response {
  return new Response(
    JSON.stringify({
      error: IN_BAND_SUPERSEDED_CODE,
      message: 'In-band write expected seqInBand 3, but the run is at 4.',
      details: { expectedSeqInBand: 3, seqInBand: 4 },
      seq: 9,
      seqInBand: 4,
    }),
    { status: 412, headers: { 'content-type': 'application/json' } }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('in-band writer fence (world-vercel)', () => {
  it('maps a 412 in-band-superseded to InBandSupersededError with the counters', () => {
    let thrown: unknown;
    try {
      throwForErrorResponse(
        412,
        { 'content-type': 'application/json' },
        new TextEncoder().encode(
          JSON.stringify({
            error: IN_BAND_SUPERSEDED_CODE,
            seq: 9,
            seqInBand: 4,
          })
        ),
        'createEvent',
        'http://x'
      );
    } catch (error) {
      thrown = error;
    }
    expect(InBandSupersededError.is(thrown)).toBe(true);
    // Never mistaken for the precondition guard's 412, which reloads and
    // retries the write.
    expect(PreconditionFailedError.is(thrown)).toBe(false);
    expect(thrown).toMatchObject({
      status: 412,
      code: IN_BAND_SUPERSEDED_CODE,
      seq: 9,
      seqInBand: 4,
    });
  });

  it('maps a CBOR 412 in-band-superseded the same way', () => {
    let thrown: unknown;
    try {
      throwForErrorResponse(
        412,
        { 'content-type': 'application/cbor' },
        encode({ error: IN_BAND_SUPERSEDED_CODE, seq: 2, seqInBand: 2 }),
        'createEvent',
        'http://x'
      );
    } catch (error) {
      thrown = error;
    }
    expect(InBandSupersededError.is(thrown)).toBe(true);
    expect(thrown).toMatchObject({ seq: 2, seqInBand: 2 });
  });

  it('drops counters that are not nonnegative integers', () => {
    let thrown: unknown;
    try {
      throwForErrorResponse(
        412,
        { 'content-type': 'application/json' },
        new TextEncoder().encode(
          JSON.stringify({
            error: IN_BAND_SUPERSEDED_CODE,
            seq: -1,
            seqInBand: '4',
          })
        ),
        'createEvent',
        'http://x'
      );
    } catch (error) {
      thrown = error;
    }
    expect(InBandSupersededError.is(thrown)).toBe(true);
    expect((thrown as InBandSupersededError).seq).toBeUndefined();
    expect((thrown as InBandSupersededError).seqInBand).toBeUndefined();
  });

  it('keeps every other 412 a PreconditionFailedError', () => {
    let thrown: unknown;
    try {
      throwForErrorResponse(
        412,
        { 'content-type': 'application/json' },
        new TextEncoder().encode(
          JSON.stringify({ error: 'precondition-failed', seqInBand: 4 })
        ),
        'createEvent',
        'http://x'
      );
    } catch (error) {
      thrown = error;
    }
    expect(PreconditionFailedError.is(thrown)).toBe(true);
    expect(InBandSupersededError.is(thrown)).toBe(false);
  });

  it('sends the fence on a single create and surfaces the refusal without retrying', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => supersededResponse());

    const rejection = await createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'step_created',
        specVersion: 7,
        correlationId: 'step_1',
        eventData: { stepName: 'a', input: new Uint8Array([1]) },
      },
      { inBand: true, expectedSeqInBand: 3 },
      config
    ).catch((error: unknown) => error);

    expect(InBandSupersededError.is(rejection)).toBe(true);
    expect(rejection).toMatchObject({ seq: 9, seqInBand: 4 });
    // The fence refusal is final for this write: a retry would carry the same
    // stale count.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [meta] = frameMetas(fetchSpy.mock.calls[0][1]?.body);
    expect(meta).toMatchObject({ inBand: true, expectedSeqInBand: 3 });
  });

  it('sends no fence fields when the caller sets none', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => supersededResponse());

    await createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'step_created',
        specVersion: 7,
        correlationId: 'step_1',
        eventData: { stepName: 'a', input: new Uint8Array([1]) },
      },
      undefined,
      config
    ).catch(() => undefined);

    const [meta] = frameMetas(fetchSpy.mock.calls[0][1]?.body);
    expect(meta).not.toHaveProperty('inBand');
    expect(meta).not.toHaveProperty('expectedSeqInBand');
  });

  it('sends the same fence on every frame of a batch', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => supersededResponse());

    const rejection = await createWorkflowRunEventBatch(
      'wrun_1',
      ['step_1', 'step_2', 'step_3'].map((correlationId) => ({
        event: {
          eventType: 'step_created' as const,
          specVersion: 7,
          correlationId,
          eventData: { stepName: 'a', input: new Uint8Array([1]) },
        },
      })),
      { inBand: true, expectedSeqInBand: 5 },
      config
    ).catch((error: unknown) => error);

    expect(InBandSupersededError.is(rejection)).toBe(true);
    const metas = frameMetas(fetchSpy.mock.calls[0][1]?.body);
    expect(metas).toHaveLength(3);
    for (const meta of metas) {
      expect(meta).toMatchObject({ inBand: true, expectedSeqInBand: 5 });
    }
  });

  it('drops malformed counters on the shared errorForResponse path too', () => {
    const error = errorForResponse(412, 'superseded', {
      code: IN_BAND_SUPERSEDED_CODE,
      details: { seq: 1.5, seqInBand: -1 },
    });
    expect(InBandSupersededError.is(error)).toBe(true);
    expect((error as InBandSupersededError).seq).toBeUndefined();
    expect((error as InBandSupersededError).seqInBand).toBeUndefined();
  });

  it('tags the span with the World count on a refusal, and only then', () => {
    const span = { setAttributes: vi.fn() };
    recordInBandRefusal(
      span,
      new InBandSupersededError('superseded', { seq: 9, seqInBand: 4 })
    );
    expect(span.setAttributes).toHaveBeenCalledWith({
      'workflow.event.seq_in_band': 4,
    });

    span.setAttributes.mockClear();
    recordInBandRefusal(span, new InBandSupersededError('superseded'));
    recordInBandRefusal(span, new PreconditionFailedError('stale'));
    expect(span.setAttributes).not.toHaveBeenCalled();
  });
});
