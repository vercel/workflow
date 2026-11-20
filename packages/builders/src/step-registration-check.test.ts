import { WorkflowBuildError } from '@workflow/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowManifest } from './apply-swc-transform.js';
import {
  ALLOW_UNREGISTERED_STEPS_ENV,
  assertWorkflowStepsAreRegistered,
  findUnregisteredSteps,
} from './step-registration-check.js';

const steps = (
  entries: Record<string, Record<string, string>>
): WorkflowManifest => ({
  steps: Object.fromEntries(
    Object.entries(entries).map(([file, fns]) => [
      file,
      Object.fromEntries(
        Object.entries(fns).map(([name, stepId]) => [name, { stepId }])
      ),
    ])
  ),
});

describe('findUnregisteredSteps', () => {
  it('returns nothing when every workflow step is registered', () => {
    const manifest = steps({
      'workflows/a.ts': { doWork: 'step//./workflows/a//doWork' },
    });
    expect(
      findUnregisteredSteps({
        workflowsManifest: manifest,
        stepsManifest: manifest,
      })
    ).toEqual([]);
  });

  it('returns nothing when neither bundle has steps', () => {
    expect(
      findUnregisteredSteps({ workflowsManifest: {}, stepsManifest: {} })
    ).toEqual([]);
  });

  it('returns a workflow step the steps bundle does not register', () => {
    expect(
      findUnregisteredSteps({
        workflowsManifest: steps({
          'workflows/a.ts': {
            doWork: 'step//./workflows/a//doWork',
            registered: 'step//./workflows/a//registered',
          },
        }),
        stepsManifest: steps({
          'workflows/a.ts': { registered: 'step//./workflows/a//registered' },
        }),
      })
    ).toEqual([
      {
        stepId: 'step//./workflows/a//doWork',
        file: 'workflows/a.ts',
        functionName: 'doWork',
      },
    ]);
  });

  it('matches steps by ID even when the two bundles record different files', () => {
    expect(
      findUnregisteredSteps({
        workflowsManifest: steps({
          'node_modules/pkg/dist/workflow.js': { run: 'step//pkg@1.0.0//run' },
        }),
        stepsManifest: steps({
          'node_modules/pkg/dist/node.js': { run: 'step//pkg@1.0.0//run' },
        }),
      })
    ).toEqual([]);
  });

  it('ignores steps only the steps bundle registers', () => {
    expect(
      findUnregisteredSteps({
        workflowsManifest: {},
        stepsManifest: steps({ 'steps/a.ts': { a: 'step//./steps/a//a' } }),
      })
    ).toEqual([]);
  });

  it('lists each missing step once, sorted by ID', () => {
    const result = findUnregisteredSteps({
      workflowsManifest: steps({
        'b.ts': { b: 'step//./b//b' },
        'a.ts': { a: 'step//./a//a' },
        'a-copy.ts': { a: 'step//./a//a' },
      }),
      stepsManifest: {},
    });
    expect(result.map((step) => step.stepId)).toEqual([
      'step//./a//a',
      'step//./b//b',
    ]);
  });
});

describe('assertWorkflowStepsAreRegistered', () => {
  afterEach(() => {
    delete process.env[ALLOW_UNREGISTERED_STEPS_ENV];
  });

  const missingOne = {
    workflowsManifest: steps({
      'workflows/a.ts': { doWork: 'step//./workflows/a//doWork' },
    }),
    stepsManifest: {},
  };

  it('does nothing when every step is registered', () => {
    const warn = vi.fn();
    expect(
      assertWorkflowStepsAreRegistered({
        workflowsManifest: missingOne.workflowsManifest,
        stepsManifest: missingOne.workflowsManifest,
        warn,
      })
    ).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws a build error that names the step, its file, and its ID', () => {
    let error: unknown;
    try {
      assertWorkflowStepsAreRegistered(missingOne);
    } catch (caught) {
      error = caught;
    }
    expect(WorkflowBuildError.is(error)).toBe(true);
    const message = (error as Error).message;
    expect(message).toContain(
      'Workflow code can call 1 step that is not registered in the steps bundle.'
    );
    expect(message).toContain(
      'doWork in workflows/a.ts (step//./workflows/a//doWork)'
    );
    expect(message).toContain('"use step" is the first statement');
    expect(message).toContain(`${ALLOW_UNREGISTERED_STEPS_ENV}=1`);
    expect(message).toContain(
      'https://workflow-sdk.dev/err/step-not-registered'
    );
  });

  it('lists at most ten steps', () => {
    const fns: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      fns[`step${String(i).padStart(2, '0')}`] =
        `step//./a//step${String(i).padStart(2, '0')}`;
    }
    expect(() =>
      assertWorkflowStepsAreRegistered({
        workflowsManifest: steps({ 'a.ts': fns }),
        stepsManifest: {},
      })
    ).toThrow(
      /can call 12 steps that are not registered[\s\S]*step09 in a\.ts[\s\S]*\.\.\.and 2 more/
    );
  });

  it('warns instead of throwing behind the escape hatch', () => {
    process.env[ALLOW_UNREGISTERED_STEPS_ENV] = '1';
    const warn = vi.fn();
    const result = assertWorkflowStepsAreRegistered({ ...missingOne, warn });
    expect(result.map((step) => step.functionName)).toEqual(['doWork']);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('doWork in workflows/a.ts');
  });

  it('only treats "1" as the escape hatch', () => {
    process.env[ALLOW_UNREGISTERED_STEPS_ENV] = 'true';
    expect(() => assertWorkflowStepsAreRegistered(missingOne)).toThrow(
      /not registered in the steps bundle/
    );
  });
});
