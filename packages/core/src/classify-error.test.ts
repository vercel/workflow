import {
  CorruptedEventLogError,
  HookConflictError,
  RUN_ERROR_CODES,
  RuntimeDecryptionError,
  ThrottleError,
  TooEarlyError,
  WorkflowNotRegisteredError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import {
  classifyRunError,
  isRetryableWorldError,
  isWorldContractError,
} from './classify-error.js';

describe('classifyRunError', () => {
  it('classifies CorruptedEventLogError as CORRUPTED_EVENT_LOG', () => {
    expect(
      classifyRunError(new CorruptedEventLogError('corrupted event log'))
    ).toBe(RUN_ERROR_CODES.CORRUPTED_EVENT_LOG);
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

  it('classifies WorkflowWorldError as USER_ERROR (from user code fetch)', () => {
    expect(
      classifyRunError(
        new WorkflowWorldError('Internal Server Error', { status: 500 })
      )
    ).toBe(RUN_ERROR_CODES.USER_ERROR);
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

  it('does NOT classify world response parse failures as WORLD_CONTRACT_ERROR', () => {
    // A parse failure means we could not read/decode the response body — a
    // transient infra blip (truncated stream, gateway HTML, connection reset),
    // not a genuine protocol disagreement. It must stay retryable so callers
    // propagate it to the queue instead of failing the run.
    const parseError = new WorkflowWorldError(
      'Failed to parse response body for GET /v3/runs/wrun/events',
      { code: 'PARSE_ERROR' }
    );
    expect(isWorldContractError(parseError)).toBe(false);
    expect(classifyRunError(parseError)).not.toBe(
      RUN_ERROR_CODES.WORLD_CONTRACT_ERROR
    );
  });

  it('isWorldContractError distinguishes schema validation (fatal) from parse failures (retryable)', () => {
    expect(
      isWorldContractError(
        new WorkflowWorldError(
          'Schema validation failed for GET /v3/runs/wrun/events',
          { code: 'SCHEMA_VALIDATION' }
        )
      )
    ).toBe(true);
    expect(
      isWorldContractError(
        new WorkflowWorldError(
          'Failed to parse response body for GET /v3/runs/wrun/events',
          { code: 'PARSE_ERROR' }
        )
      )
    ).toBe(false);
    // A status-bearing HTTP error (e.g. 5xx) is never a contract error — it
    // is already retryable via the status check.
    expect(
      isWorldContractError(
        new WorkflowWorldError('Internal Server Error', { status: 500 })
      )
    ).toBe(false);
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
});

describe('isRetryableWorldError', () => {
  it('treats response-body parse failures as retryable', () => {
    expect(
      isRetryableWorldError(
        new WorkflowWorldError(
          'Failed to parse response body for GET /v3/runs/wrun/events',
          { code: 'PARSE_ERROR' }
        )
      )
    ).toBe(true);
  });

  it('treats world 5xx errors as retryable', () => {
    expect(
      isRetryableWorldError(
        new WorkflowWorldError('Bad Gateway', { status: 502 })
      )
    ).toBe(true);
  });

  it('treats throttle and too-early errors as retryable', () => {
    expect(isRetryableWorldError(new ThrottleError('rate limited'))).toBe(true);
    expect(isRetryableWorldError(new TooEarlyError('too early'))).toBe(true);
  });

  it('does NOT treat schema validation (contract) errors as retryable', () => {
    expect(
      isRetryableWorldError(
        new WorkflowWorldError('Schema validation failed for GET /events', {
          code: 'SCHEMA_VALIDATION',
        })
      )
    ).toBe(false);
  });

  it('does NOT treat client (4xx) errors as retryable', () => {
    expect(
      isRetryableWorldError(
        new WorkflowWorldError('Bad Request', { status: 400 })
      )
    ).toBe(false);
  });

  it('does NOT treat plain user/runtime errors as retryable', () => {
    expect(isRetryableWorldError(new Error('boom'))).toBe(false);
    expect(
      isRetryableWorldError(new WorkflowRuntimeError('runtime boom'))
    ).toBe(false);
  });
});
