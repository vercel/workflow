import {
  EntityConflictError,
  HookConflictError,
  HookNotFoundError,
  HookReservedError,
  START_HOOK_ADMISSION_DISABLED,
  START_HOOK_ADMISSION_REJECTED,
  START_HOOK_CANDIDATE_CANCELLED,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import { START_HOOK_WIRE_CODES } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { ulid } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowRunEvent, splitEventDataForV4 } from './events.js';
import { throwForErrorResponse } from './events-v4.js';
import { getHookByToken } from './hooks.js';
import { errorForResponse } from './http-core.js';
import { createWorld, EXPERIMENTAL_START_HOOK_ENV } from './index.js';

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

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const json = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('atomic start Hook wire contract (world-vercel)', () => {
  const tokenRetentionUntil = new Date('2026-11-01T00:00:00.000Z');

  it.each([
    'run_created',
    'run_started',
  ] as const)('carries startHook in the %s frame meta', (eventType) => {
    const { meta } = splitEventDataForV4({
      eventType,
      specVersion: 8,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        input: new Uint8Array([1]),
        startHook: { token: 'order:1', tokenRetentionUntil },
      },
    } as never);
    expect(meta.startHook).toEqual({ token: 'order:1', tokenRetentionUntil });
  });

  it('omits tokenRetentionUntil when the start sets none', () => {
    const { meta } = splitEventDataForV4({
      eventType: 'run_created',
      specVersion: 8,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        input: new Uint8Array([1]),
        startHook: { token: 'order:1' },
      },
    } as never);
    expect(meta.startHook).toEqual({ token: 'order:1' });
  });

  it('sends startHook on the POSTed run_created frame, retention as a CBOR Date', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: START_HOOK_WIRE_CODES.conflict,
            message: 'taken',
            token: 'order:1',
            conflictingRunId: 'wrun_owner',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        )
    );

    const rejection = await createWorkflowRunEvent(
      `wrun_${ulid()}`,
      {
        eventType: 'run_created',
        specVersion: 8,
        eventData: {
          deploymentId: 'dpl_1',
          workflowName: 'wf',
          input: new Uint8Array([1]),
          startHook: { token: 'order:1', tokenRetentionUntil },
        },
      },
      undefined,
      config
    ).catch((error: unknown) => error);

    expect(HookConflictError.is(rejection)).toBe(true);
    expect(rejection).toMatchObject({
      token: 'order:1',
      conflictingRunId: 'wrun_owner',
    });
    // A refusal is the candidate's final decision: never retried.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [meta] = frameMetas(fetchSpy.mock.calls[0][1]?.body);
    expect(meta.startHook).toEqual({ token: 'order:1', tokenRetentionUntil });
    expect(
      (meta.startHook as { tokenRetentionUntil: unknown }).tokenRetentionUntil
    ).toBeInstanceOf(Date);
  });

  it('maps a 409 start-hook-conflict to HookConflictError, not EntityConflictError', () => {
    for (const body of [
      json({
        error: START_HOOK_WIRE_CODES.conflict,
        token: 'order:1',
        conflictingRunId: 'wrun_owner',
      }),
      encode({
        code: START_HOOK_WIRE_CODES.conflict,
        token: 'order:1',
        conflictingRunId: 'wrun_owner',
      }),
    ]) {
      const thrown = thrownBy(() =>
        throwForErrorResponse(
          409,
          {
            'content-type':
              body instanceof Buffer ? 'application/cbor' : 'application/json',
          },
          body,
          'createEvent',
          'http://x'
        )
      );
      expect(HookConflictError.is(thrown)).toBe(true);
      expect(EntityConflictError.is(thrown)).toBe(false);
      expect(thrown).toMatchObject({
        token: 'order:1',
        conflictingRunId: 'wrun_owner',
      });
    }
  });

  it('leaves conflictingRunId unset when the body omits it, so start() can call it a contract error', () => {
    const error = errorForResponse(409, 'taken', {
      code: START_HOOK_WIRE_CODES.conflict,
      details: { token: 'order:1', conflictingRunId: 42 },
    });
    expect(HookConflictError.is(error)).toBe(true);
    expect((error as HookConflictError).conflictingRunId).toBeUndefined();
  });

  it('keeps a plain 409 an EntityConflictError', () => {
    expect(EntityConflictError.is(errorForResponse(409, 'run exists'))).toBe(
      true
    );
  });

  it.each([
    [START_HOOK_WIRE_CODES.admissionRejected, START_HOOK_ADMISSION_REJECTED],
    [START_HOOK_WIRE_CODES.disabled, START_HOOK_ADMISSION_DISABLED],
  ])('maps a 400 %s to %s', (code, mapped) => {
    const thrown = thrownBy(() =>
      throwForErrorResponse(
        400,
        { 'content-type': 'application/json' },
        json({ error: code, message: 'no' }),
        'createEvent',
        'http://x'
      )
    );
    expect(WorkflowWorldError.is(thrown)).toBe(true);
    expect(thrown).toMatchObject({ status: 400, code: mapped });
  });

  it.each([
    'expired',
    'disabled',
  ])('forwards the rejection reason %s on the v4 path', (reason) => {
    const thrown = thrownBy(() =>
      throwForErrorResponse(
        400,
        { 'content-type': 'application/json' },
        json({
          error: START_HOOK_WIRE_CODES.admissionRejected,
          message: 'no',
          details: { reason },
        }),
        'createEvent',
        'http://x'
      )
    );
    expect(thrown).toMatchObject({
      code: START_HOOK_ADMISSION_REJECTED,
      reason,
    });
  });

  it('forwards the rejection reason on the v3 path, and reports the kill switch as disabled', () => {
    expect(
      errorForResponse(400, 'no', {
        code: START_HOOK_WIRE_CODES.admissionRejected,
        details: { reason: 'token_mismatch' },
      })
    ).toMatchObject({
      code: START_HOOK_ADMISSION_REJECTED,
      reason: 'token_mismatch',
    });
    expect(
      errorForResponse(400, 'no', {
        code: START_HOOK_WIRE_CODES.admissionRejected,
        details: { reason: 7 },
      })
    ).not.toHaveProperty('reason', 7);
    expect(
      errorForResponse(400, 'off', { code: START_HOOK_WIRE_CODES.disabled })
    ).toMatchObject({
      code: START_HOOK_ADMISSION_DISABLED,
      reason: 'disabled',
    });
  });

  it('maps a 409 start-hook-candidate-cancelled to START_HOOK_CANDIDATE_CANCELLED, not EntityConflictError', () => {
    const thrown = thrownBy(() =>
      throwForErrorResponse(
        409,
        { 'content-type': 'application/json' },
        json({
          error: START_HOOK_WIRE_CODES.candidateCancelled,
          message: 'cancelled before it was created',
          runId: 'wrun_1',
        }),
        'createEvent',
        'http://x'
      )
    );
    expect(EntityConflictError.is(thrown)).toBe(false);
    expect(thrown).toMatchObject({
      status: 409,
      code: START_HOOK_CANDIDATE_CANCELLED,
    });
  });

  it('keeps an unrelated 400 untagged', () => {
    const error = errorForResponse(400, 'bad', { code: 'validation-error' });
    expect((error as WorkflowWorldError).code).toBe('validation-error');
  });

  it('carries the start Hook metadata bytes in the meta', () => {
    const metadata = new Uint8Array([7, 8, 9]);
    const { meta } = splitEventDataForV4({
      eventType: 'run_created',
      specVersion: 8,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        input: new Uint8Array([1]),
        startHook: { token: 'order:1', metadata },
      },
    } as never);
    expect(meta.startHook).toEqual({ token: 'order:1', metadata });
  });

  it('maps a 425 hook-reserved to HookReservedError, never HookNotFoundError', () => {
    const thrown = thrownBy(() =>
      throwForErrorResponse(
        425,
        { 'content-type': 'application/json', 'retry-after': '2' },
        json({ error: START_HOOK_WIRE_CODES.reserved, runId: 'wrun_owner' }),
        'createEvent',
        'http://x'
      )
    );
    expect(HookReservedError.is(thrown)).toBe(true);
    expect(HookNotFoundError.is(thrown)).toBe(false);
    expect(thrown).toMatchObject({ runId: 'wrun_owner', retryAfter: 2 });
  });

  it('keeps a plain 425 a TooEarlyError', () => {
    expect(TooEarlyError.is(errorForResponse(425, 'later'))).toBe(true);
  });

  it('getHookByToken surfaces a reserved token with the token it asked about', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: START_HOOK_WIRE_CODES.reserved,
            runId: 'wrun_owner',
          }),
          {
            status: 425,
            headers: { 'content-type': 'application/json', 'retry-after': '1' },
          }
        )
    );
    const error = await getHookByToken('order:1', config).catch(
      (e: unknown) => e
    );
    expect(HookReservedError.is(error)).toBe(true);
    expect(error).toMatchObject({
      token: 'order:1',
      runId: 'wrun_owner',
      retryAfter: 1,
    });
  });

  it('keeps contention a retryable 429', () => {
    expect(ThrottleError.is(errorForResponse(429, 'busy'))).toBe(true);
  });

  it(`declares atomicStartHook only with ${EXPERIMENTAL_START_HOOK_ENV}`, () => {
    expect(createWorld(config).capabilities?.atomicStartHook).toBeUndefined();
    vi.stubEnv(EXPERIMENTAL_START_HOOK_ENV, '1');
    expect(createWorld(config).capabilities?.atomicStartHook).toEqual({
      active: true,
    });
    vi.stubEnv(EXPERIMENTAL_START_HOOK_ENV, 'yes');
    expect(createWorld(config).capabilities?.atomicStartHook).toBeUndefined();
  });
});
