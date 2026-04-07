import {
  HookConflictError,
  RUN_ERROR_CODES,
  WorkflowNotRegisteredError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import { classifyRunError } from './classify-error.js';

describe('classifyRunError', () => {
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
});
