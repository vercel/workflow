import {
  CorruptedEventLogError,
  RUN_ERROR_CODES,
  SerializationError,
  StepNotRegisteredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { describe, expect, test } from 'vitest';
import {
  NotInStepContextError,
  NotInWorkflowContextError,
} from './context-errors.js';
import { describeError, describeRunError } from './describe-error.js';

describe('describeError', () => {
  test('plain user errors are attributed to the user with no hint', () => {
    const result = describeError(new Error('something user code did'));
    expect(result.attribution).toBe('user');
    expect(result.errorCode).toBe(RUN_ERROR_CODES.USER_ERROR);
    expect(result.hint).toBeUndefined();
  });

  test('non-Error throws are attributed to the user', () => {
    expect(describeError('string').attribution).toBe('user');
    expect(describeError(undefined).attribution).toBe('user');
    expect(describeError(null).attribution).toBe('user');
    expect(describeError({ oops: true }).attribution).toBe('user');
  });

  test('SerializationError is attributed to the user with a hint', () => {
    const result = describeError(
      new SerializationError('Failed to serialize step arguments')
    );
    expect(result.attribution).toBe('user');
    expect(result.hint).toContain('serialized');
  });

  test('context-violation errors are attributed to the user', () => {
    const workflowOnly = describeError(
      new NotInWorkflowContextError(
        'createHook',
        'hooks: https://example.com/hooks'
      )
    );
    expect(workflowOnly.attribution).toBe('user');
    expect(workflowOnly.hint).toContain('wrong context');

    const stepOnly = describeError(
      new NotInStepContextError(
        'respondWith',
        'webhook responses: https://example.com/webhook'
      )
    );
    expect(stepOnly.attribution).toBe('user');
    expect(stepOnly.hint).toContain('wrong context');
  });

  test('WorkflowRuntimeError is attributed to the SDK', () => {
    const result = describeError(
      new WorkflowRuntimeError('corrupted event log')
    );
    expect(result.attribution).toBe('sdk');
    expect(result.errorCode).toBe(RUN_ERROR_CODES.RUNTIME_ERROR);
    expect(result.hint).toContain('internal workflow SDK error');
  });

  test('CorruptedEventLogError is attributed to the SDK with a distinct code', () => {
    const result = describeError(
      new CorruptedEventLogError('corrupted event log')
    );
    expect(result.attribution).toBe('sdk');
    expect(result.errorCode).toBe(RUN_ERROR_CODES.CORRUPTED_EVENT_LOG);
    expect(result.hint).toContain('event log contains');
  });

  test('StepNotRegisteredError (subclass of WorkflowRuntimeError) is attributed to the SDK', () => {
    const result = describeError(new StepNotRegisteredError('missingStep'));
    expect(result.attribution).toBe('sdk');
    expect(result.errorCode).toBe(RUN_ERROR_CODES.RUNTIME_ERROR);
  });

  test('REPLAY_TIMEOUT via precomputed errorCode is attributed to the SDK', () => {
    const result = describeError(undefined, RUN_ERROR_CODES.REPLAY_TIMEOUT);
    expect(result.attribution).toBe('sdk');
    expect(result.errorCode).toBe(RUN_ERROR_CODES.REPLAY_TIMEOUT);
    expect(result.hint).toContain(
      'replay between step boundaries took too long'
    );
  });

  test('MAX_DELIVERIES_EXCEEDED via precomputed errorCode is attributed to the SDK', () => {
    const result = describeError(
      undefined,
      RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED
    );
    expect(result.attribution).toBe('sdk');
    expect(result.errorCode).toBe(RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED);
    expect(result.hint).toContain('max-delivery budget');
  });

  test('WORLD_CONTRACT_ERROR via precomputed errorCode is attributed to the SDK', () => {
    const result = describeError(
      undefined,
      RUN_ERROR_CODES.WORLD_CONTRACT_ERROR
    );
    expect(result.attribution).toBe('sdk');
    expect(result.errorCode).toBe(RUN_ERROR_CODES.WORLD_CONTRACT_ERROR);
    expect(result.hint).toContain('SDK contract');
  });

  test('precomputed errorCode wins over classifyRunError when both are provided', () => {
    // A plain Error would classify as USER_ERROR, but passing REPLAY_TIMEOUT
    // explicitly overrides that — useful for callers that know the failure
    // category from the surrounding runtime context.
    const result = describeError(
      new Error('something'),
      RUN_ERROR_CODES.REPLAY_TIMEOUT
    );
    expect(result.errorCode).toBe(RUN_ERROR_CODES.REPLAY_TIMEOUT);
    expect(result.attribution).toBe('sdk');
  });
});

describe('describeRunError', () => {
  test('plain user error event fields are attributed to the user with no hint', () => {
    const result = describeRunError({
      errorCode: RUN_ERROR_CODES.USER_ERROR,
      errorName: 'Error',
    });
    expect(result.attribution).toBe('user');
    expect(result.hint).toBeUndefined();
  });

  test('SerializationError by name is attributed to the user with a hint', () => {
    const result = describeRunError({
      errorCode: RUN_ERROR_CODES.USER_ERROR,
      errorName: 'SerializationError',
    });
    expect(result.attribution).toBe('user');
    expect(result.hint).toContain('serialized');
  });

  test('context-violation error names are attributed to the user', () => {
    const result = describeRunError({
      errorCode: RUN_ERROR_CODES.USER_ERROR,
      errorName: 'NotInWorkflowContextError',
    });
    expect(result.attribution).toBe('user');
    expect(result.hint).toContain('wrong context');
  });

  test('WorkflowRuntimeError name is attributed to the SDK', () => {
    const result = describeRunError({
      errorCode: RUN_ERROR_CODES.RUNTIME_ERROR,
      errorName: 'WorkflowRuntimeError',
    });
    expect(result.attribution).toBe('sdk');
    expect(result.hint).toContain('internal workflow SDK error');
  });

  test('REPLAY_TIMEOUT errorCode is attributed to the SDK', () => {
    const result = describeRunError({
      errorCode: RUN_ERROR_CODES.REPLAY_TIMEOUT,
    });
    expect(result.attribution).toBe('sdk');
    expect(result.hint).toContain(
      'replay between step boundaries took too long'
    );
  });

  test('CORRUPTED_EVENT_LOG errorCode is attributed to the SDK', () => {
    const result = describeRunError({
      errorCode: RUN_ERROR_CODES.CORRUPTED_EVENT_LOG,
    });
    expect(result.attribution).toBe('sdk');
    expect(result.hint).toContain('event log contains');
  });

  test('CorruptedEventLogError name restores the distinct code', () => {
    const result = describeRunError({
      errorName: 'CorruptedEventLogError',
    });
    expect(result.attribution).toBe('sdk');
    expect(result.errorCode).toBe(RUN_ERROR_CODES.CORRUPTED_EVENT_LOG);
    expect(result.hint).toContain('event log contains');
  });

  test('MAX_DELIVERIES_EXCEEDED errorCode is attributed to the SDK', () => {
    const result = describeRunError({
      errorCode: RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED,
    });
    expect(result.attribution).toBe('sdk');
    expect(result.hint).toContain('max-delivery budget');
  });

  test('WORLD_CONTRACT_ERROR errorCode is attributed to the SDK', () => {
    const result = describeRunError({
      errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
    });
    expect(result.attribution).toBe('sdk');
    expect(result.hint).toContain('SDK contract');
  });

  test('RUNTIME_ERROR code without errorName still lands as SDK', () => {
    const result = describeRunError({
      errorCode: RUN_ERROR_CODES.RUNTIME_ERROR,
    });
    expect(result.attribution).toBe('sdk');
    expect(result.hint).toContain('internal workflow SDK error');
  });

  test('missing errorCode defaults to USER_ERROR', () => {
    const result = describeRunError({});
    expect(result.attribution).toBe('user');
    expect(result.errorCode).toBe(RUN_ERROR_CODES.USER_ERROR);
    expect(result.hint).toBeUndefined();
  });
});

/**
 * Snapshot tests for the full `describeError` / `describeRunError` payload
 * shape. These act as a regression gate on the exact strings that feed into
 * log metadata fields (`errorAttribution`, `hint`) and UI attribution — we
 * don't want a reworded hint to silently change what users see in their
 * logs + docs links.
 */
describe('describeError — payload shape snapshots', () => {
  test('plain user Error payload', () => {
    expect(describeError(new Error('boom'))).toMatchInlineSnapshot(`
      {
        "attribution": "user",
        "errorCode": "USER_ERROR",
      }
    `);
  });

  test('SerializationError payload', () => {
    expect(
      describeError(new SerializationError('boom'))
    ).toMatchInlineSnapshot(`
        {
          "attribution": "user",
          "errorCode": "USER_ERROR",
          "hint": "A value passed across a workflow/step boundary could not be serialized. See the error message for the offending path and the Learn More link for details.",
        }
      `);
  });

  test('context-violation error payload', () => {
    expect(
      describeError(
        new NotInWorkflowContextError(
          'createHook',
          'https://workflow-sdk.dev/docs/api-reference/workflow/create-hook'
        )
      )
    ).toMatchInlineSnapshot(`
      {
        "attribution": "user",
        "errorCode": "USER_ERROR",
        "hint": "A workflow-only or step-only API was called from the wrong context. The error message includes the exact API and how to move the call.",
      }
    `);
  });

  test('WorkflowRuntimeError payload', () => {
    expect(
      describeError(new WorkflowRuntimeError('internal invariant'))
    ).toMatchInlineSnapshot(`
        {
          "attribution": "sdk",
          "errorCode": "RUNTIME_ERROR",
          "hint": "This is an internal workflow SDK error, not a bug in your code. If it keeps happening, please report it with the stack trace and the runId.",
        }
      `);
  });

  test('CorruptedEventLogError payload', () => {
    expect(
      describeError(new CorruptedEventLogError('event mismatch'))
    ).toMatchInlineSnapshot(`
        {
          "attribution": "sdk",
          "errorCode": "CORRUPTED_EVENT_LOG",
          "hint": "The workflow event log contains orphaned or mismatched events and cannot be replayed. This is an internal workflow SDK error; please report it with the runId.",
        }
      `);
  });

  test('REPLAY_TIMEOUT via precomputed errorCode payload', () => {
    expect(
      describeError(undefined, RUN_ERROR_CODES.REPLAY_TIMEOUT)
    ).toMatchInlineSnapshot(`
        {
          "attribution": "sdk",
          "errorCode": "REPLAY_TIMEOUT",
          "hint": "The workflow replay between step boundaries took too long. This bounds workflow-VM and event-log replay time only — step bodies (\`"use step"\` functions) are excluded. This usually means the event log is unusually large or the workflow function is doing heavy synchronous work in workflow code outside of step bodies. Override the default budget via the WORKFLOW_REPLAY_TIMEOUT_MS env var if needed.",
        }
      `);
  });

  test('MAX_DELIVERIES_EXCEEDED via precomputed errorCode payload', () => {
    expect(
      describeError(undefined, RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED)
    ).toMatchInlineSnapshot(`
      {
        "attribution": "sdk",
        "errorCode": "MAX_DELIVERIES_EXCEEDED",
        "hint": "The workflow queue exceeded its max-delivery budget. This usually indicates a persistent runtime failure — check the most recent stack traces for the underlying cause.",
      }
    `);
  });

  test('WORLD_CONTRACT_ERROR via precomputed errorCode payload', () => {
    expect(
      describeError(undefined, RUN_ERROR_CODES.WORLD_CONTRACT_ERROR)
    ).toMatchInlineSnapshot(`
      {
        "attribution": "sdk",
        "errorCode": "WORLD_CONTRACT_ERROR",
        "hint": "The workflow backend returned data that violated the SDK contract. This is not retryable; please report it with the stack trace and runId.",
      }
    `);
  });
});
