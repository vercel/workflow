import { FatalError } from '@workflow/errors';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NotInStepContextError,
  NotInWorkflowContextError,
  NotInWorkflowOrStepContextError,
  throwNotInWorkflowContext,
  UnavailableInWorkflowContextError,
} from './context-errors.js';
import {
  WORKFLOW_CONTEXT_SYMBOL,
  type WorkflowMetadata,
} from './workflow/get-workflow-metadata.js';

// These tests assert on the plain-text form of the messages. In a TTY chalk
// would add color, but vitest runs without a TTY so chalk is level=0 and
// the styling helpers are pass-throughs. Snapshots therefore match the raw
// structure we care about (╰▶ / ├▶ tree + labels + docs URL).

describe('NotInWorkflowContextError', () => {
  it('frames the function name and docs link', () => {
    const err = new NotInWorkflowContextError(
      'createHook()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/create-hook'
    );
    expect(err.name).toBe('NotInWorkflowContextError');
    expect(err.message).toMatchInlineSnapshot(`
      "\`createHook()\` can only be called inside a workflow function
      ╰▶ docs: https://workflow-sdk.dev/docs/api-reference/workflow/create-hook"
    `);
  });

  it('does not expose functionName as an enumerable own property', () => {
    // Regression: `readonly functionName` as a constructor param-property used
    // to leak through util.inspect (Next.js error overlay, Node's default
    // error formatter). Keep this invariant so the terminal output stays
    // clean.
    const err = new NotInWorkflowContextError(
      'createHook()',
      'https://example.com/docs'
    );
    expect(Object.keys(err)).not.toContain('functionName');
    expect((err as any).functionName).toBeUndefined();
  });
});

describe('NotInStepContextError', () => {
  it('uses "step function" phrasing', () => {
    const err = new NotInStepContextError(
      'getStepMetadata()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/get-step-metadata'
    );
    expect(err.message).toContain('can only be called inside a step function');
    expect(err.message).toContain(
      'docs: https://workflow-sdk.dev/docs/api-reference/workflow/get-step-metadata'
    );
  });
});

describe('NotInWorkflowOrStepContextError', () => {
  it('uses "workflow or step function" phrasing', () => {
    const err = new NotInWorkflowOrStepContextError(
      'getWorkflowMetadata()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/get-workflow-metadata'
    );
    expect(err.message).toContain(
      'can only be called inside a workflow or step function'
    );
  });
});

describe('UnavailableInWorkflowContextError', () => {
  afterEach(() => {
    delete (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL];
  });

  it('names the workflow when a context is active', () => {
    (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] = {
      workflowName: 'workflow//./src/workflows/example.ts//myWorkflow',
    } as WorkflowMetadata;

    const err = new UnavailableInWorkflowContextError(
      'resumeHook()',
      'https://workflow-sdk.dev/docs/api-reference/workflow-api/resume-hook'
    );
    expect(err.message).toContain('cannot be called from a workflow context');
    expect(err.message).toContain(
      'workflow//./src/workflows/example.ts//myWorkflow'
    );
  });

  it('falls back to a generic phrasing when no context is present', () => {
    const err = new UnavailableInWorkflowContextError(
      'resumeHook()',
      'https://workflow-sdk.dev/docs/api-reference/workflow-api/resume-hook'
    );
    expect(err.message).toContain('from a workflow context');
  });
});

describe('plain .message / lazy pretty rendering', () => {
  it('.message contains no ANSI escape bytes', () => {
    // The user's structured logs, log drains, and CBOR event payloads all
    // read `err.message` as a string. ANSI bytes leaking into them produced
    // unreadable `\x1B[...m` noise in JSON. Keep `.message` plain.
    const err = new NotInWorkflowContextError(
      'createHook()',
      'https://example.com/docs'
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI check
    expect(err.message).not.toMatch(/\x1B\[/);
  });

  it('.stack contains no ANSI escape bytes', () => {
    const err = new NotInWorkflowContextError(
      'createHook()',
      'https://example.com/docs'
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI check
    expect(err.stack ?? '').not.toMatch(/\x1B\[/);
  });

  it('util.inspect(err) reveals the pretty framed form', () => {
    // Node prints uncaught / logged errors via util.inspect. The pretty
    // (framed) output belongs on the render path, not in stored state.
    const err = new NotInWorkflowContextError(
      'createHook()',
      'https://example.com/docs'
    );
    const out = inspect(err);
    expect(out).toContain('NotInWorkflowContextError:');
    expect(out).toContain('createHook()');
    expect(out).toContain('can only be called inside a workflow function');
    expect(out).toContain('╰▶');
    expect(out).toContain('docs:');
  });

  it('util.inspect(err) does not duplicate framed detail lines', () => {
    // Regression: `.message` is multi-line (`title\n╰▶ docs: …`), so V8's
    // `.stack` reads `Name: messageLine1\nmessageLine2\n    at …`. Slicing
    // only the first line of stack glued the framed-detail tail of the
    // message onto the prepended pretty form and rendered every `╰▶ docs:`
    // line twice. Now we slice past all message lines.
    const out = inspect(
      new NotInWorkflowContextError('createHook()', 'https://example.com/docs')
    );
    // Multi-detail variants would also duplicate every detail; the docs
    // line is the canonical case.
    expect(out).not.toMatch(/╰▶ docs:.*\n.*╰▶ docs:/s);
    // ╰▶ should appear exactly once for the single-detail error.
    const occurrences = (out.match(/╰▶ docs:/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('err.toString() also returns the pretty framed form', () => {
    const err = new NotInWorkflowContextError(
      'createHook()',
      'https://example.com/docs'
    );
    expect(err.toString()).toContain('NotInWorkflowContextError:');
    expect(err.toString()).toContain('╰▶');
  });
});

describe('FatalError.is() gate', () => {
  // The step handler uses FatalError.is() to decide retry vs bubble-up.
  // Context-violation errors can't succeed on retry — they signal the
  // user called a workflow-only API from the wrong context — so burning
  // three retry attempts just produces duplicated log output.
  it.each([
    [
      'NotInWorkflowContextError',
      () =>
        new NotInWorkflowContextError('createHook()', 'https://example.com'),
    ],
    [
      'NotInStepContextError',
      () =>
        new NotInStepContextError('getStepMetadata()', 'https://example.com'),
    ],
    [
      'NotInWorkflowOrStepContextError',
      () =>
        new NotInWorkflowOrStepContextError(
          'getWorkflowMetadata()',
          'https://example.com'
        ),
    ],
    [
      'UnavailableInWorkflowContextError',
      () =>
        new UnavailableInWorkflowContextError(
          'resumeHook()',
          'https://example.com'
        ),
    ],
  ])('%s satisfies FatalError.is', (_name, make) => {
    expect(FatalError.is(make())).toBe(true);
  });
});

describe('throw helpers redirect the stack to the caller', () => {
  // V8-only. Skip silently on engines without Error.captureStackTrace.
  const hasCaptureStackTrace =
    typeof (Error as unknown as { captureStackTrace?: unknown })
      .captureStackTrace === 'function';

  it.skipIf(!hasCaptureStackTrace)(
    'throwNotInWorkflowContext: top stack frame is the caller, not the framework function',
    () => {
      function frameworkGate() {
        throwNotInWorkflowContext(
          'frameworkGate()',
          'https://example.com/docs',
          frameworkGate
        );
      }

      function userCallSite() {
        frameworkGate();
      }

      try {
        userCallSite();
      } catch (err) {
        const stack = (err as Error).stack ?? '';
        // The first "at ..." frame should reference userCallSite, not
        // frameworkGate or throwNotInWorkflowContext.
        const firstFrame = stack
          .split('\n')
          .find((l) => l.trim().startsWith('at '));
        expect(firstFrame).toBeDefined();
        expect(firstFrame).toContain('userCallSite');
        expect(firstFrame).not.toContain('frameworkGate');
        expect(firstFrame).not.toContain('throwNotInWorkflowContext');
        return;
      }
      throw new Error('expected throwNotInWorkflowContext to throw');
    }
  );
});
