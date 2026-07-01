import {
  CorruptedEventLogError,
  HookConflictError,
  ReplayDivergenceError,
  RUN_ERROR_CODES,
  RuntimeDecryptionError,
  ThrottleError,
  TooEarlyError,
  WorkflowNotRegisteredError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import { classifyRunError, isRetryableWorldError } from './classify-error.js';

describe('classifyRunError', () => {
  it('classifies CorruptedEventLogError as CORRUPTED_EVENT_LOG', () => {
    expect(
      classifyRunError(new CorruptedEventLogError('corrupted event log'))
    ).toBe(RUN_ERROR_CODES.CORRUPTED_EVENT_LOG);
  });

  it('classifies ReplayDivergenceError as REPLAY_DIVERGENCE', () => {
    expect(
      classifyRunError(
        new ReplayDivergenceError('replay took another path', {
          eventId: 'event-1',
        })
      )
    ).toBe(RUN_ERROR_CODES.REPLAY_DIVERGENCE);
  });

  it('classifies WorkflowRuntimeError as RUNTIME_ERROR', () => {
    expect(
      classifyRunError(new WorkflowRuntimeError('corrupted event log'))
    ).toBe(RUN_ERROR_CODES.RUNTIME_ERROR);
  });

  it('classifies WorkflowNotRegisteredError as RUNTIME_ERROR', () => {
    expect(classifyRunError(new WorkflowNotRegisteredError('myWorkflow'))).toBe(
      RUN_ERROR_CODES.RUNTIME_ERROR
    );
  });

  it('classifies plain Error as USER_ERROR', () => {
    expect(classifyRunError(new Error('user code broke'))).toBe(
      RUN_ERROR_CODES.USER_ERROR
    );
  });

  it('classifies TypeError as USER_ERROR', () => {
    expect(classifyRunError(new TypeError('cannot read property'))).toBe(
      RUN_ERROR_CODES.USER_ERROR
    );
  });

  it('classifies a 5xx WorkflowWorldError as WORLD_CONTRACT_ERROR (backend fault, retryable)', () => {
    // A WorkflowWorldError only originates from the world adapter talking to
    // workflow-server, so a 5xx is the backend's fault, not the user's. These
    // are normally redelivered (isRetryableWorldError); if one reaches terminal
    // classification it must be a world error, not USER_ERROR.
    expect(
      classifyRunError(
        new WorkflowWorldError('Internal Server Error', { status: 500 })
      )
    ).toBe(RUN_ERROR_CODES.WORLD_CONTRACT_ERROR);
  });

  it('classifies world schema validation failures as WORLD_CONTRACT_ERROR', () => {
    expect(
      classifyRunError(
        new WorkflowWorldError(
          'Schema validation failed for POST /v3/runs/wrun/events',
          { code: 'SCHEMA_VALIDATION' }
        )
      )
    ).toBe(RUN_ERROR_CODES.WORLD_CONTRACT_ERROR);
  });

  it('classifies world response parse failures as WORLD_CONTRACT_ERROR', () => {
    expect(
      classifyRunError(
        new WorkflowWorldError(
          'Failed to parse response body for GET /v3/runs/wrun/events',
          { code: 'PARSE_ERROR' }
        )
      )
    ).toBe(RUN_ERROR_CODES.WORLD_CONTRACT_ERROR);
  });

  it('classifies string throw as USER_ERROR', () => {
    expect(classifyRunError('string error')).toBe(RUN_ERROR_CODES.USER_ERROR);
  });

  it('classifies null throw as USER_ERROR', () => {
    expect(classifyRunError(null)).toBe(RUN_ERROR_CODES.USER_ERROR);
  });

  it('classifies undefined throw as USER_ERROR', () => {
    expect(classifyRunError(undefined)).toBe(RUN_ERROR_CODES.USER_ERROR);
  });

  it('classifies HookConflictError as USER_ERROR (duplicate token is user mistake)', () => {
    expect(classifyRunError(new HookConflictError('my-token'))).toBe(
      RUN_ERROR_CODES.USER_ERROR
    );
  });

  it('classifies RuntimeDecryptionError as RUNTIME_ERROR', () => {
    expect(classifyRunError(new RuntimeDecryptionError('decrypt failed'))).toBe(
      RUN_ERROR_CODES.RUNTIME_ERROR
    );
  });

  it('classifies a raw native OperationError as USER_ERROR', () => {
    // A bare DOMException-shaped OperationError does not match any
    // RUNTIME_ERROR_CHECKS entry — the encryption module is expected to
    // wrap these in RuntimeDecryptionError before they bubble up here.
    const native = new Error(
      'The operation failed for an operation-specific reason'
    );
    native.name = 'OperationError';
    expect(classifyRunError(native)).toBe(RUN_ERROR_CODES.USER_ERROR);
  });

  it('classifies a TRANSPORT error as WORLD_CONTRACT_ERROR (backend fault, not USER_ERROR)', () => {
    // Transport blips are normally redelivered via the queue (see
    // isRetryableWorldError); if one ever reaches terminal classification it is
    // the backend/firewall's fault, not the user's — track it as a world error.
    expect(
      classifyRunError(
        new WorkflowWorldError(
          'GET /events transport failure (UND_ERR_REQ_RETRY)',
          {
            code: 'TRANSPORT',
          }
        )
      )
    ).toBe(RUN_ERROR_CODES.WORLD_CONTRACT_ERROR);
  });

  it('classifies a ThrottleError (firewall challenge / 429) as WORLD_CONTRACT_ERROR', () => {
    expect(classifyRunError(new ThrottleError('rate limited'))).toBe(
      RUN_ERROR_CODES.WORLD_CONTRACT_ERROR
    );
  });
});

describe('isRetryableWorldError', () => {
  it('treats ThrottleError (429) as retryable', () => {
    expect(isRetryableWorldError(new ThrottleError('rate limited'))).toBe(true);
  });

  it('treats 5xx WorkflowWorldError as retryable', () => {
    expect(
      isRetryableWorldError(
        new WorkflowWorldError('Bad Gateway', { status: 502 })
      )
    ).toBe(true);
    expect(
      isRetryableWorldError(
        new WorkflowWorldError('Service Unavailable', { status: 503 })
      )
    ).toBe(true);
  });

  it('treats TRANSPORT and TIMEOUT codes as retryable', () => {
    expect(
      isRetryableWorldError(
        new WorkflowWorldError('transport failure (UND_ERR_REQ_RETRY)', {
          code: 'TRANSPORT',
        })
      )
    ).toBe(true);
    expect(
      isRetryableWorldError(
        new WorkflowWorldError('timed out after 60000ms', { code: 'TIMEOUT' })
      )
    ).toBe(true);
  });

  it('does NOT treat 4xx (other than 429) as retryable', () => {
    expect(
      isRetryableWorldError(
        new WorkflowWorldError('Bad Request', { status: 400 })
      )
    ).toBe(false);
  });

  it('does NOT treat contract errors (parse/schema) as retryable', () => {
    expect(
      isRetryableWorldError(
        new WorkflowWorldError(
          'Failed to parse response body for GET /events',
          {
            code: 'PARSE_ERROR',
          }
        )
      )
    ).toBe(false);
    expect(
      isRetryableWorldError(
        new WorkflowWorldError('Schema validation failed for POST /events', {
          code: 'SCHEMA_VALIDATION',
        })
      )
    ).toBe(false);
  });

  it('does NOT treat TooEarlyError (425 step pacing) as retryable here', () => {
    expect(isRetryableWorldError(new TooEarlyError('too early'))).toBe(false);
  });

  it('does NOT treat plain errors or non-errors as retryable', () => {
    expect(isRetryableWorldError(new Error('boom'))).toBe(false);
    expect(
      isRetryableWorldError(new WorkflowWorldError('no status or code'))
    ).toBe(false);
    expect(isRetryableWorldError('string')).toBe(false);
    expect(isRetryableWorldError(null)).toBe(false);
    expect(isRetryableWorldError(undefined)).toBe(false);
  });
});
