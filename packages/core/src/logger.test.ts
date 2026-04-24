import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runtimeLogger } from './logger.js';

describe('logger', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('error logs go to console.error with [workflow-sdk] prefix', () => {
    runtimeLogger.error('boom', { foo: 'bar' });
    expect(errorSpy).toHaveBeenCalledWith('[workflow-sdk] boom', {
      foo: 'bar',
    });
  });

  test('warn logs go to console.warn with [workflow-sdk] prefix', () => {
    runtimeLogger.warn('watch out', { foo: 'bar' });
    expect(warnSpy).toHaveBeenCalledWith('[workflow-sdk] watch out', {
      foo: 'bar',
    });
  });

  test('info and debug do not print to console by default', () => {
    runtimeLogger.info('quiet');
    runtimeLogger.debug('quieter');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('child() merges parent metadata into every call', () => {
    const child = runtimeLogger.child({ workflowRunId: 'run-1' });
    child.error('boom', { stepId: 'step-1' });
    expect(errorSpy).toHaveBeenCalledWith('[workflow-sdk] boom', {
      workflowRunId: 'run-1',
      stepId: 'step-1',
    });
  });

  test('call-site metadata wins over child metadata on conflict', () => {
    const child = runtimeLogger.child({ workflowRunId: 'parent-id' });
    child.error('boom', { workflowRunId: 'override' });
    expect(errorSpy).toHaveBeenCalledWith('[workflow-sdk] boom', {
      workflowRunId: 'override',
    });
  });

  test('child can be chained', () => {
    const runLogger = runtimeLogger.child({ workflowRunId: 'run-1' });
    const stepLogger = runLogger.child({ stepId: 'step-1' });
    stepLogger.error('boom');
    expect(errorSpy).toHaveBeenCalledWith('[workflow-sdk] boom', {
      workflowRunId: 'run-1',
      stepId: 'step-1',
    });
  });

  test('forRun attaches workflowRunId and workflowName', () => {
    const runLogger = runtimeLogger.forRun('run-1', 'myWorkflow');
    runLogger.error('boom');
    expect(errorSpy).toHaveBeenCalledWith('[workflow-sdk] boom', {
      workflowRunId: 'run-1',
      workflowName: 'myWorkflow',
    });
  });

  test('forRun without workflowName omits the key', () => {
    const runLogger = runtimeLogger.forRun('run-1');
    runLogger.error('boom');
    expect(errorSpy).toHaveBeenCalledWith('[workflow-sdk] boom', {
      workflowRunId: 'run-1',
    });
  });

  test('forRun accepts extra metadata', () => {
    const runLogger = runtimeLogger.forRun('run-1', 'myWorkflow', {
      stepId: 'step-1',
    });
    runLogger.error('boom');
    expect(errorSpy).toHaveBeenCalledWith('[workflow-sdk] boom', {
      workflowRunId: 'run-1',
      workflowName: 'myWorkflow',
      stepId: 'step-1',
    });
  });

  test('no metadata omits the argument object', () => {
    runtimeLogger.error('boom');
    expect(errorSpy).toHaveBeenCalledWith('[workflow-sdk] boom', '');
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
            "[workflow-sdk] Step "step//my-step" threw a FatalError",
            {
              "errorAttribution": "user",
              "errorMessage": "boom",
              "errorName": "FatalError",
              "hint": "Move the call to a step function.",
              "stepId": "step_456",
              "stepName": "step//my-step",
              "workflowName": "workflow//my-wf",
              "workflowRunId": "wrun_123",
            },
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
            "[workflow-sdk] Step "step//doWork" hit max retries — bubbling error thrown by your step to the parent workflow",
            {
              "attempt": 4,
              "errorAttribution": "user",
              "errorMessage": "Transient failure",
              "errorName": "Error",
              "retryCount": 3,
              "stepId": "step_xyz",
              "stepName": "step//doWork",
              "workflowName": "workflow//main",
              "workflowRunId": "wrun_abc",
            },
          ],
        ]
      `);
    });
  });
});
