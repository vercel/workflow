import { describe, expect, test } from 'vitest';
import { formatLogMetadata } from './log-format.js';

// chalk respects FORCE_COLOR=0 (which vitest doesn't set, but the runner
// has no TTY so chalk's level is 0 → ANSI helpers pass-through). The
// snapshots below match the plain-text structural form, which is what
// log drains and CI logs see.

describe('formatLogMetadata', () => {
  test('returns null for empty metadata', () => {
    expect(formatLogMetadata('msg', undefined)).toBeNull();
    expect(formatLogMetadata('msg', {})).toBeNull();
  });

  test('renders the canonical step-fatal payload', () => {
    const out = formatLogMetadata(
      'Step add (./workflows/x) threw a FatalError — bubbling up to parent workflow',
      {
        workflowRunId: 'wrun_01ABC',
        stepId: 'step_01XYZ',
        stepName: 'step//./workflows/x//add',
        errorAttribution: 'user',
        errorName: 'NotInWorkflowContextError',
        errorMessage:
          '`createHook()` can only be called inside a workflow function',
        hint: 'A workflow-only or step-only API was called from the wrong context. The error message includes the exact API and how to move the call.',
      }
    );
    expect(out).toMatchInlineSnapshot(`
      "  user error · NotInWorkflowContextError
        run    wrun_01ABC
        step   step_01XYZ · add (./workflows/x)
        hint: A workflow-only or step-only API was called from the wrong context. The error message includes the exact API and how to move the call."
    `);
  });

  test('renders the hit-max-retries payload with attempt + retryCount', () => {
    const out = formatLogMetadata(
      'Step add (./workflows/x) hit max retries — bubbling error',
      {
        workflowRunId: 'wrun_01ABC',
        workflowName: 'workflow//./workflows/x//myWorkflow',
        stepId: 'step_01XYZ',
        stepName: 'step//./workflows/x//add',
        attempt: 4,
        retryCount: 3,
        errorAttribution: 'user',
        errorName: 'Error',
        errorMessage: 'Transient failure',
      }
    );
    expect(out).toMatchInlineSnapshot(`
      "  user error · Error
        run    wrun_01ABC · myWorkflow (./workflows/x)
        step   step_01XYZ · add (./workflows/x)
        retry  4 attempts · 3 retries"
    `);
  });

  test('renders sdk-attributed errors with the sdk badge', () => {
    const out = formatLogMetadata(
      'Workflow myFlow failed due to an SDK runtime error',
      {
        errorCode: 'RUNTIME_ERROR',
        errorAttribution: 'sdk',
        errorName: 'WorkflowRuntimeError',
        errorMessage: 'corrupted event log',
        hint: 'This is an internal workflow SDK error.',
      }
    );
    expect(out).toMatchInlineSnapshot(`
      "  sdk error · WorkflowRuntimeError
        code   RUNTIME_ERROR
        hint: This is an internal workflow SDK error."
    `);
  });

  test('drops errorMessage when the parent message already includes it', () => {
    // Important: avoids double-printing the same string in the stack and
    // in the metadata block.
    const errorMessage = 'thing went wrong';
    const out = formatLogMetadata(`Step foo threw\nError: ${errorMessage}`, {
      errorAttribution: 'user',
      errorName: 'Error',
      errorMessage,
    });
    expect(out).not.toContain(`message`);
    expect(out).toMatchInlineSnapshot(`"  user error · Error"`);
  });

  test('omits errorStack always (the parent message owns the stack)', () => {
    const out = formatLogMetadata('msg', {
      errorStack: 'Error: ...\n  at foo (...)\n  ...',
      errorName: 'Error',
      errorAttribution: 'user',
    });
    expect(out).not.toContain('errorStack');
    expect(out).not.toContain('at foo');
  });

  test('falls back gracefully on machine names it cannot parse', () => {
    const out = formatLogMetadata('msg', {
      workflowRunId: 'wrun_X',
      workflowName: 'not-a-machine-name',
    });
    // Should still emit the row — never silently drop info.
    expect(out).toContain('wrun_X');
  });

  test('renders unknown fields as a sorted key/value tail', () => {
    const out = formatLogMetadata('msg', {
      zoo: 'last',
      apple: 'first',
      banana: 42,
    });
    expect(out).toMatchInlineSnapshot(`
      "  apple  first
        banana 42
        zoo    last"
    `);
  });
});
