import { describe, expect, it } from 'vitest';
import {
  EntityConflictError,
  ERROR_SLUGS,
  FatalError,
  IDEMPOTENCY_KEY_CONFLICT_CODE,
  WorkflowRunAlreadyStartedError,
  WorkflowWorldError,
} from './index.js';

describe('WorkflowRunAlreadyStartedError', () => {
  it('names the holding run and carries the 409 conflict code', () => {
    const error = new WorkflowRunAlreadyStartedError('wrun_holder', {
      runStatus: 'running',
      workflowName: 'workflow//./src/orders//process',
      idempotencyKey: 'order-1',
    });

    expect(error.name).toBe('WorkflowRunAlreadyStartedError');
    expect(error.runId).toBe('wrun_holder');
    expect(error.runStatus).toBe('running');
    expect(error.workflowName).toBe('workflow//./src/orders//process');
    expect(error.idempotencyKey).toBe('order-1');
    expect(error.status).toBe(409);
    expect(error.code).toBe(IDEMPOTENCY_KEY_CONFLICT_CODE);
    expect(error.code).toBe('idempotency-key-conflict');
    expect(error.message).toContain('wrun_holder');
    expect(error.message).toContain('(running)');
    expect(error.message).toContain(
      `https://workflow-sdk.dev/err/${ERROR_SLUGS.RUN_ALREADY_STARTED}`
    );
  });

  it('keeps a backend-supplied message', () => {
    const error = new WorkflowRunAlreadyStartedError('wrun_holder', {
      message: 'Idempotency key is held by run wrun_holder',
    });
    expect(error.message).toMatch(
      /^Idempotency key is held by run wrun_holder/
    );
  });

  it('omits optional fields that were not reported', () => {
    const error = new WorkflowRunAlreadyStartedError('wrun_holder');
    expect(error.runStatus).toBeUndefined();
    expect(error.workflowName).toBeUndefined();
    expect(error.idempotencyKey).toBeUndefined();
    expect(error.message).not.toContain('(');
  });

  it('is recognized by its own guard and no other conflict guard', () => {
    const error = new WorkflowRunAlreadyStartedError('wrun_holder');
    expect(WorkflowRunAlreadyStartedError.is(error)).toBe(true);
    // A self-conflict (the caller's own run already exists) is an
    // EntityConflictError; a refusal naming another run must never look
    // like one, or start() would treat it as its own write landing.
    expect(EntityConflictError.is(error)).toBe(false);
    expect(
      WorkflowRunAlreadyStartedError.is(new EntityConflictError('x'))
    ).toBe(false);
    expect(WorkflowWorldError.is(error)).toBe(false);
    expect(error).toBeInstanceOf(WorkflowWorldError);
  });

  it('is fatal, so a step calling start() is not retried on a refusal', () => {
    const error = new WorkflowRunAlreadyStartedError('wrun_holder');
    expect(FatalError.is(error)).toBe(true);
    expect(error.fatal).toBe(true);
    // Fatal does not change its identity.
    expect(WorkflowRunAlreadyStartedError.is(error)).toBe(true);
    expect(FatalError.is(new EntityConflictError('x'))).toBe(false);
  });

  it('registers its class on globalThis for revivers in other realms', () => {
    expect(
      (globalThis as Record<symbol, unknown>)[
        Symbol.for('@workflow/errors//WorkflowRunAlreadyStartedError')
      ]
    ).toBe(WorkflowRunAlreadyStartedError);
  });

  it('is recognized across realms by name', () => {
    const foreign = Object.assign(new Error('held'), {
      name: 'WorkflowRunAlreadyStartedError',
      runId: 'wrun_holder',
    });
    expect(WorkflowRunAlreadyStartedError.is(foreign)).toBe(true);
  });
});
