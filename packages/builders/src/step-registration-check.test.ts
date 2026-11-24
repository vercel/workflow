import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkflowBuildError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('steps in files discovery did not read', () => {
  // The workflow bundle compiles every step in a file it imports, called or
  // not, while discovery does not read some files on purpose. A step in a
  // file discovery never read is not a discovery bug, so it warns instead of
  // failing a build where nothing may call it. Each case is decided by what
  // discovery read, not by where the file is installed.
  let root: string;

  const file = (relativePath: string, packageJson?: object) => {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    if (packageJson) {
      writeFileSync(
        join(dirname(path), 'package.json'),
        JSON.stringify(packageJson)
      );
    }
    return path;
  };
  const check = ({
    key,
    path,
    discoveredFiles,
    discoverWorkflowsInNodeModules = true,
  }: {
    key: string;
    path: string;
    discoveredFiles: string[];
    discoverWorkflowsInNodeModules?: boolean;
  }) => {
    const warn = vi.fn();
    let error: unknown;
    try {
      assertWorkflowStepsAreRegistered({
        workflowsManifest: steps({
          [key]: { unusedStep: `step//${key}//unusedStep` },
        }),
        stepsManifest: {},
        discovery: {
          stepFilePaths: new Map([[key, path]]),
          discoveredFiles: new Set(discoveredFiles),
          discoverWorkflowsInNodeModules,
        },
        warn,
      });
    } catch (caught) {
      error = caught;
    }
    return {
      error,
      warning: warn.mock.calls.map((call) => call[0]).join('\n'),
    };
  };

  beforeEach(() => {
    delete process.env[ALLOW_UNREGISTERED_STEPS_ENV];
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-step-check-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fails the build for an application file discovery read', () => {
    const path = file('app/workflows/a.ts');
    const { error } = check({
      key: 'workflows/a.ts',
      path,
      discoveredFiles: [path],
    });
    expect(error).toBeInstanceOf(WorkflowBuildError);
  });

  it('fails the build for a package file discovery read', () => {
    const path = file('app/node_modules/lib/index.js', {
      name: 'lib',
      dependencies: { workflow: '*' },
    });
    const { error } = check({
      key: 'node_modules/lib/index.js',
      path,
      discoveredFiles: [path],
    });
    expect(error).toBeInstanceOf(WorkflowBuildError);
  });

  it('counts a file discovery read through a symlink as read', () => {
    const path = file('packages/lib/index.js', { name: 'lib' });
    mkdirSync(join(root, 'app/node_modules'), { recursive: true });
    symlinkSync(
      join(root, 'packages/lib'),
      join(root, 'app/node_modules/lib'),
      'junction'
    );
    const { error } = check({
      key: 'node_modules/lib/index.js',
      path,
      discoveredFiles: [join(root, 'app/node_modules/lib/index.js')],
    });
    expect(error).toBeInstanceOf(WorkflowBuildError);
  });

  it('fails the build for an SDK file discovery did not read', () => {
    // Discovery always reads the SDK while it descends into node_modules, so
    // an SDK step it did not read (Run's, when @workflow/core cannot be
    // resolved) is a discovery bug.
    const path = file('app/node_modules/@workflow/core/dist/runtime/run.js', {
      name: '@workflow/core',
    });
    const { error } = check({
      key: 'node_modules/@workflow/core/dist/runtime/run.js',
      path,
      discoveredFiles: [],
    });
    expect(error).toBeInstanceOf(WorkflowBuildError);
  });

  it.each([
    ['in a package installed in the app', 'app/node_modules/lib/index.js'],
    [
      'in a package hoisted to the repository root',
      'node_modules/lib/index.js',
    ],
    ['in a package elsewhere in the repository', 'packages/lib/index.js'],
  ])('warns for a step %s that discovery did not read', (_label, relativePath) => {
    // The package depends on workflow, so neither its location nor its own
    // manifest says discovery skipped it: only what discovery read does
    // (here, it was reached through a package that does not depend on
    // workflow).
    const path = file(relativePath, {
      name: 'lib',
      dependencies: { workflow: '*' },
    });
    const { error, warning } = check({
      key: 'node_modules/lib/index.js',
      path,
      discoveredFiles: [],
    });
    expect(error).toBeUndefined();
    expect(warning).toMatch(
      /unusedStep in node_modules\/lib\/index\.js .*: discovery did not read this file/
    );
    expect(warning).not.toMatch(/Workflow SDK bug/);
  });

  it('warns for an SDK step while node_modules discovery is off', () => {
    // With node_modules discovery off the SDK is not read either, so its
    // steps (fetch in workflow/stdlib) cannot be registered. That is the
    // opt-out working, not a bug.
    const path = file('app/node_modules/workflow/dist/stdlib.js', {
      name: 'workflow',
    });
    const { error, warning } = check({
      key: 'node_modules/workflow/dist/stdlib.js',
      path,
      discoveredFiles: [],
      discoverWorkflowsInNodeModules: false,
    });
    expect(error).toBeUndefined();
    expect(warning).toMatch(/node_modules discovery is off/);
  });

  it('fails the build for the missed steps and warns for the skipped ones', () => {
    const read = file('app/workflows/a.ts');
    const unread = file('node_modules/lib/index.js', { name: 'lib' });
    const warn = vi.fn();
    expect(() =>
      assertWorkflowStepsAreRegistered({
        workflowsManifest: steps({
          'workflows/a.ts': { doWork: 'step//./workflows/a//doWork' },
          'node_modules/lib/index.js': {
            unusedStep: 'step//lib@1.0.0//unusedStep',
          },
        }),
        stepsManifest: {},
        discovery: {
          stepFilePaths: new Map([
            ['workflows/a.ts', read],
            ['node_modules/lib/index.js', unread],
          ]),
          discoveredFiles: new Set([read]),
          discoverWorkflowsInNodeModules: true,
        },
        warn,
      })
    ).toThrow(/can call 1 step[\s\S]*doWork in workflows\/a\.ts/);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(
      'unusedStep in node_modules/lib/index.js'
    );
  });

  it('fails the build for a step whose file it does not know', () => {
    expect(() =>
      assertWorkflowStepsAreRegistered({
        workflowsManifest: steps({
          'workflows/a.ts': { doWork: 'step//./workflows/a//doWork' },
        }),
        stepsManifest: {},
        discovery: {
          stepFilePaths: new Map(),
          discoveredFiles: new Set(),
          discoverWorkflowsInNodeModules: true,
        },
      })
    ).toThrow(WorkflowBuildError);
  });

  it('treats every unregistered step as missed without discovery facts', () => {
    expect(() =>
      assertWorkflowStepsAreRegistered({
        workflowsManifest: steps({
          'node_modules/lib/index.js': { unusedStep: 'step//lib//unusedStep' },
        }),
        stepsManifest: {},
      })
    ).toThrow(WorkflowBuildError);
  });
});
