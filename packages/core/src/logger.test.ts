import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildLogger, runtimeLogger } from './logger.js';

describe('logger', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  // The logger composes `[workflow-sdk] <message>\n<formatted metadata>`
  // into a single string argument and passes it to `console.error` /
  // `console.warn`. This avoids `util.inspect` quoting multi-line stacks
  // and paragraph hints inside an object dump. See `./log-format.ts`.
  test('error logs go to console.error with [workflow-sdk] prefix and unknown fields fall through', () => {
    runtimeLogger.error('boom', { foo: 'bar' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toHaveLength(1);
    expect(errorSpy.mock.calls[0][0]).toContain('[workflow-sdk] boom');
    expect(errorSpy.mock.calls[0][0]).toContain('foo');
    expect(errorSpy.mock.calls[0][0]).toContain('bar');
  });

  test('warn logs go to console.warn with [workflow-sdk] prefix', () => {
    runtimeLogger.warn('watch out', { foo: 'bar' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[workflow-sdk] watch out');
    expect(warnSpy.mock.calls[0][0]).toContain('foo');
  });

  test('info and debug do not print to console by default', () => {
    runtimeLogger.info('quiet');
    runtimeLogger.debug('quieter');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('build logger debug uses workflow:build namespace', () => {
    buildLogger.debug('quiet');
    expect(debugSpy).not.toHaveBeenCalled();

    vi.stubEnv('DEBUG', 'workflow:build');
    buildLogger.debug('verbose');
    expect(debugSpy).toHaveBeenCalledWith('[workflow:build] verbose', '');

    vi.stubEnv('DEBUG', 'workflow:*,-workflow:build');
    buildLogger.debug('quiet again');
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  test('child() merges parent metadata into every call', () => {
    const child = runtimeLogger.child({ workflowRunId: 'run-1' });
    child.error('boom', { stepId: 'step-1' });
    const out = errorSpy.mock.calls[0][0] as string;
    expect(out).toContain('[workflow-sdk] boom');
    expect(out).toContain('run-1');
    expect(out).toContain('step-1');
  });

  test('call-site metadata wins over child metadata on conflict', () => {
    const child = runtimeLogger.child({ workflowRunId: 'parent-id' });
    child.error('boom', { workflowRunId: 'override' });
    const out = errorSpy.mock.calls[0][0] as string;
    expect(out).toContain('override');
    expect(out).not.toContain('parent-id');
  });

  test('child can be chained', () => {
    const runLogger = runtimeLogger.child({ workflowRunId: 'run-1' });
    const stepLogger = runLogger.child({ stepId: 'step-1' });
    stepLogger.error('boom');
    const out = errorSpy.mock.calls[0][0] as string;
    expect(out).toContain('run-1');
    expect(out).toContain('step-1');
  });

  test('forRun attaches workflowRunId and workflowName', () => {
    // Production passes machine-form names like `workflow//./module//fn`,
    // which the formatter renders as `fn (./module)`.
    const runLogger = runtimeLogger.forRun(
      'run-1',
      'workflow//./src/jobs//myWorkflow'
    );
    runLogger.error('boom');
    const out = errorSpy.mock.calls[0][0] as string;
    expect(out).toContain('run-1');
    expect(out).toContain('myWorkflow (./src/jobs)');
  });

  test('forRun without workflowName omits the key', () => {
    const runLogger = runtimeLogger.forRun('run-1');
    runLogger.error('boom');
    const out = errorSpy.mock.calls[0][0] as string;
    expect(out).toContain('run-1');
  });

  test('forRun accepts extra metadata', () => {
    const runLogger = runtimeLogger.forRun('run-1', 'myWorkflow', {
      stepId: 'step-1',
    });
    runLogger.error('boom');
    const out = errorSpy.mock.calls[0][0] as string;
    expect(out).toContain('run-1');
    expect(out).toContain('step-1');
  });

  test('no metadata: only the prefix line is emitted', () => {
    runtimeLogger.error('boom');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe('[workflow-sdk] boom');
  });

  /**
   * Snapshot tests for the exact shape of runtime log output. These act as
   * regression gates on what users see in their log drains, so that
   * refactors of the logger don't accidentally change field ordering, the
   * prefix, or whether metadata is merged.
   */
  describe('shape snapshots', () => {
    test('scoped logger emits the canonical step-failure call signature', () => {
      const log = runtimeLogger.forRun('wrun_123', 'workflow//my-wf').child({
        stepId: 'step_456',
        stepName: 'step//my-step',
      });

      log.error('Step "step//my-step" threw a FatalError', {
        errorAttribution: 'user',
        errorName: 'FatalError',
        errorMessage: 'boom',
        hint: 'Move the call to a step function.',
      });

      expect(errorSpy.mock.calls).toMatchInlineSnapshot(`
        [
          [
            "[workflow-sdk] Step "step//my-step" threw a FatalError
          user error · FatalError
          run    wrun_123
          step   step_456
          hint: Move the call to a step function.",
          ],
        ]
      `);
    });

    test('hit-max-retries style call signature', () => {
      const log = runtimeLogger.forRun('wrun_abc', 'workflow//main').child({
        stepId: 'step_xyz',
        stepName: 'step//doWork',
      });

      log.error(
        'Step "step//doWork" hit max retries — bubbling error thrown by your step to the parent workflow',
        {
          attempt: 4,
          retryCount: 3,
          errorAttribution: 'user',
          errorName: 'Error',
          errorMessage: 'Transient failure',
        }
      );

      expect(errorSpy.mock.calls).toMatchInlineSnapshot(`
        [
          [
            "[workflow-sdk] Step "step//doWork" hit max retries — bubbling error thrown by your step to the parent workflow
          user error · Error
          run    wrun_abc
          step   step_xyz
          retry  4 attempts · 3 max retries",
          ],
        ]
      `);
    });
  });
});
