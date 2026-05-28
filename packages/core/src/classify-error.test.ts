import {
  CorruptedEventLogError,
  HookConflictError,
  RUN_ERROR_CODES,
  RuntimeDecryptionError,
  WorkflowNotRegisteredError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import { classifyRunError } from './classify-error.js';

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
});
