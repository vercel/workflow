import { describe, expect, test } from 'vitest';
import { composeLogLine } from './log-format.js';

// chalk respects FORCE_COLOR=0 (which vitest doesn't set, but the runner
// has no TTY so chalk's level is 0 → ANSI helpers pass-through). The
// snapshots below match the plain-text structural form, which is what
// log drains and CI logs see.

const PREFIX = '[workflow-sdk]';

describe('composeLogLine', () => {
  test('returns just the prefixed framing when no metadata or stack', () => {
    expect(composeLogLine(PREFIX, 'something happened', undefined)).toBe(
      '[workflow-sdk] something happened'
    );
    expect(composeLogLine(PREFIX, 'something happened', {})).toBe(
      '[workflow-sdk] something happened'
    );
  });

  test('renders structured fields between framing and stack body', () => {
    const out = composeLogLine(
      PREFIX,
      [
        'Step add (./workflows/x) threw a FatalError — bubbling up to parent workflow',
        'FatalError: User threw a FatalError',
        '    at maybeFailingStep (./workflows/x.ts:15:11)',
        '    at <unknown> (../../packages/core/src/runtime/step-handler.ts:535:32)',
      ].join('\n'),
      {
        workflowRunId: 'wrun_01ABC',
        stepId: 'step_01XYZ',
        stepName: 'step//./workflows/x//add',
        errorAttribution: 'user',
        errorName: 'FatalError',
        errorMessage: 'User threw a FatalError',
      }
    );
    expect(out).toMatchInlineSnapshot(`
      "[workflow-sdk] Step add (./workflows/x) threw a FatalError — bubbling up to parent workflow
        user error · FatalError
        run    wrun_01ABC
        step   step_01XYZ · add (./workflows/x)
      FatalError: User threw a FatalError
          at maybeFailingStep (./workflows/x.ts:15:11)
          at <unknown> (../../packages/core/src/runtime/step-handler.ts:535:32)"
    `);
  });

  test('collapses pnpm / next / opentelemetry frames with a summary line', () => {
    const stack = [
      'FatalError: boom',
      '    at userStep (./workflows/x.ts:15:11)',
      '    at <unknown> (../../packages/core/src/runtime/step-handler.ts:535:32)',
      '    at <unknown> (.../node_modules/.pnpm/next@16.2.1/dist/server/base-server.js:1454:9)',
      '    at <unknown> (.../node_modules/.pnpm/next@16.2.1/dist/server/dev/next-dev-server.js:394:20)',
      '    at <unknown> (.../node_modules/.pnpm/@opentelemetry+api@1.9.1/build/src/api/trace.js:160:25)',
      '    at <unknown> (../../packages/core/src/runtime/helpers.ts:414:12)',
      '    at <unknown> (node:internal/process/task_queues:64:5)',
      '    at <unknown> (.../node_modules/next/dist/server/lib/start-server.js:225:13)',
    ].join('\n');
    const out = composeLogLine(PREFIX, `Step blew up\n${stack}`, undefined);
    expect(out).toMatchInlineSnapshot(`
      "[workflow-sdk] Step blew up
      FatalError: boom
          at userStep (./workflows/x.ts:15:11)
          at <unknown> (../../packages/core/src/runtime/step-handler.ts:535:32)
              … 3 more frames in framework internals
          at <unknown> (../../packages/core/src/runtime/helpers.ts:414:12)
              … 2 more frames in framework internals"
    `);
  });

  test('renders sdk-attributed errors with the sdk badge', () => {
    const out = composeLogLine(
      PREFIX,
      'Workflow myFlow failed due to an SDK runtime error\nWorkflowRuntimeError: corrupted event log',
      {
        errorCode: 'RUNTIME_ERROR',
        errorAttribution: 'sdk',
        errorName: 'WorkflowRuntimeError',
        errorMessage: 'corrupted event log',
        hint: 'This is an internal workflow SDK error.',
      }
    );
    expect(out).toMatchInlineSnapshot(`
      "[workflow-sdk] Workflow myFlow failed due to an SDK runtime error
        sdk error · WorkflowRuntimeError
        code   RUNTIME_ERROR
        hint: This is an internal workflow SDK error.
      WorkflowRuntimeError: corrupted event log"
    `);
  });

  test('drops errorMessage when the framing line already includes it', () => {
    // The framing line of a workflow-level log embeds the error message
    // directly. Avoid printing it again as a separate field.
    const errorMessage = 'thing went wrong';
    const out = composeLogLine(
      PREFIX,
      `Workflow simple threw: ${errorMessage}\nError: ${errorMessage}`,
      {
        errorAttribution: 'user',
        errorName: 'Error',
        errorMessage,
      }
    );
    expect(out).not.toMatch(/^\s+message\s+/m);
    expect(out).toMatchInlineSnapshot(`
      "[workflow-sdk] Workflow simple threw: thing went wrong
        user error · Error
      Error: thing went wrong"
    `);
  });

  test('falls back gracefully on machine names it cannot parse', () => {
    const out = composeLogLine(PREFIX, 'msg', {
      workflowRunId: 'wrun_X',
      workflowName: 'not-a-machine-name',
    });
    expect(out).toContain('wrun_X');
  });

  test('renders unknown fields as a sorted key/value tail', () => {
    const out = composeLogLine(PREFIX, 'msg', {
      zoo: 'last',
      apple: 'first',
      banana: 42,
    });
    expect(out).toMatchInlineSnapshot(`
      "[workflow-sdk] msg
        apple  first
        banana 42
        zoo    last"
    `);
  });

  test('hit-max-retries: attempt + retryCount renders on its own row', () => {
    const out = composeLogLine(
      PREFIX,
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
      "[workflow-sdk] Step add (./workflows/x) hit max retries — bubbling error
        user error · Error
        run    wrun_01ABC · myWorkflow (./workflows/x)
        step   step_01XYZ · add (./workflows/x)
        retry  4 attempts · 3 max retries"
    `);
  });
});
