import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { WorkflowBuildError } from '@workflow/errors';
import type { Metafile } from 'esbuild';
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

describe('steps in files discovery did not scan', () => {
  // The workflow bundle compiles every step in a file it imports, called or
  // not, while discovery declines to scan some packages on purpose. A step
  // reached only through such a package warns instead of failing a build
  // where nothing may call it. Every other unregistered step is a miss.
  let root: string;
  let app: string;

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
  /** A metafile whose inputs import each other as `edges` says, keys relative to the app. */
  const graph = (edges: Record<string, string[]>): Metafile => ({
    inputs: Object.fromEntries(
      Object.entries(edges).map(([from, to]) => [
        relative(app, from),
        {
          bytes: 0,
          imports: to.map((path) => ({
            path: relative(app, path),
            kind: 'import-statement' as const,
          })),
        },
      ])
    ),
    outputs: {},
  });
  const check = ({
    paths,
    scanned = [],
    declined = [],
    edges,
    discoverWorkflowsInNodeModules = true,
  }: {
    paths: string[];
    scanned?: string[];
    declined?: string[];
    edges?: Record<string, string[]>;
    discoverWorkflowsInNodeModules?: boolean;
  }) => {
    const warn = vi.fn();
    let error: unknown;
    try {
      assertWorkflowStepsAreRegistered({
        workflowsManifest: steps({
          'lib/index.js': { unusedStep: 'step//lib//unusedStep' },
        }),
        stepsManifest: {},
        discovery: {
          stepFilePaths: new Map([['step//lib//unusedStep', new Set(paths)]]),
          discoveredFiles: new Set(scanned),
          declinedPackageRoots: new Set(declined),
          workflowBundleGraph: edges
            ? { metafile: graph(edges), workingDir: app }
            : undefined,
          workingDir: app,
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
    app = join(root, 'apps/web');
    file('apps/web/package.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fails the build for a file discovery scanned', () => {
    const lib = file('apps/web/node_modules/lib/index.js', {
      name: 'lib',
      dependencies: { workflow: '*' },
    });
    expect(check({ paths: [lib], scanned: [lib] }).error).toBeInstanceOf(
      WorkflowBuildError
    );
  });

  it('counts a file discovery scanned through a symlink as scanned', () => {
    const lib = file('packages/lib/index.js', { name: 'lib' });
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    symlinkSync(
      join(root, 'packages/lib'),
      join(app, 'node_modules/lib'),
      'junction'
    );
    expect(
      check({ paths: [lib], scanned: [join(app, 'node_modules/lib/index.js')] })
        .error
    ).toBeInstanceOf(WorkflowBuildError);
  });

  it('fails the build for a file reachable through packages discovery walks, which it could not read', () => {
    // A minified `import{charge}from"./steps.js"` that discovery's import
    // scan does not match: the package depends on workflow, discovery walks
    // it, and still never reaches steps.js. That is a miss, not a choice.
    const workflow = file('apps/web/workflows/order.ts');
    const index = file('apps/web/node_modules/minlib/index.js', {
      name: 'minlib',
      dependencies: { workflow: '*' },
    });
    const stepsFile = file('apps/web/node_modules/minlib/steps.js');
    const { error } = check({
      paths: [stepsFile],
      scanned: [workflow, index],
      edges: { [workflow]: [index], [index]: [stepsFile], [stepsFile]: [] },
    });
    expect(error).toBeInstanceOf(WorkflowBuildError);
  });

  it.each([
    ['installed in the app', 'apps/web/node_modules/lib/index.js'],
    ['hoisted to the repository root', 'node_modules/lib/index.js'],
    ['elsewhere in the repository', 'packages/lib/index.js'],
  ])('warns for a step in a declined package %s', (_label, relativePath) => {
    const workflow = file('apps/web/workflows/order.ts');
    const lib = file(relativePath, { name: 'lib' });
    const { error, warning } = check({
      paths: [lib],
      scanned: [workflow],
      declined: [dirname(lib)],
      edges: { [workflow]: [lib], [lib]: [] },
    });
    expect(error).toBeUndefined();
    expect(warning).toMatch(
      /unusedStep in lib\/index\.js .*: it is only reached through a package that does not depend on workflow/
    );
    expect(warning).not.toMatch(/Workflow SDK bug/);
  });

  it('warns for a step in a package reached only through a declined one', () => {
    // chain-a does not depend on workflow and re-exports chain-b, which does.
    const workflow = file('apps/web/workflows/order.ts');
    const chainA = file('node_modules/chain-a/index.js', { name: 'chain-a' });
    const chainB = file('node_modules/chain-b/index.js', {
      name: 'chain-b',
      dependencies: { workflow: '*' },
    });
    const { error, warning } = check({
      paths: [chainB],
      scanned: [workflow],
      declined: [dirname(chainA)],
      edges: { [workflow]: [chainA], [chainA]: [chainB], [chainB]: [] },
    });
    expect(error).toBeUndefined();
    expect(warning).toMatch(
      /only reached through a package that does not depend on workflow/
    );
  });

  it('warns for an SDK step only reached from application code while node_modules discovery is off', () => {
    const workflow = file('apps/web/workflows/order.ts');
    const stdlib = file('apps/web/node_modules/workflow/dist/stdlib.js', {
      name: 'workflow',
    });
    const { error, warning } = check({
      paths: [stdlib],
      scanned: [workflow],
      edges: { [workflow]: [stdlib], [stdlib]: [] },
      discoverWorkflowsInNodeModules: false,
    });
    expect(error).toBeUndefined();
    expect(warning).toMatch(/node_modules discovery is off/);
  });

  it("fails the build for Run's steps even while node_modules discovery is off", () => {
    // Discovery seeds the file that defines Run whether or not it descends
    // into node_modules, so an unregistered Run step is always a bug.
    const workflow = file('apps/web/workflows/order.ts');
    const run = file(
      'apps/web/node_modules/@workflow/core/dist/runtime/run.js'
    );
    writeFileSync(
      join(app, 'node_modules/@workflow/core/package.json'),
      JSON.stringify({ name: '@workflow/core' })
    );
    const { error } = check({
      paths: [run],
      scanned: [workflow],
      edges: { [workflow]: [run], [run]: [] },
      discoverWorkflowsInNodeModules: false,
    });
    expect(error).toBeInstanceOf(WorkflowBuildError);
  });

  it('ignores a declined root that contains the project', () => {
    const workflow = file('apps/web/workflows/order.ts');
    const { error } = check({
      paths: [workflow],
      declined: [root],
      edges: { [workflow]: [] },
    });
    expect(error).toBeInstanceOf(WorkflowBuildError);
  });

  it('fails the build when discovery scanned one of two copies a step was compiled from', () => {
    const workflow = file('apps/web/workflows/order.ts');
    const hoisted = file('node_modules/lib/index.js', { name: 'lib' });
    const local = file('apps/web/node_modules/lib/index.js', {
      name: 'lib',
      dependencies: { workflow: '*' },
    });
    const { error } = check({
      paths: [hoisted, local],
      scanned: [workflow, local],
      declined: [dirname(hoisted)],
      edges: { [workflow]: [hoisted, local], [hoisted]: [], [local]: [] },
    });
    expect(error).toBeInstanceOf(WorkflowBuildError);
  });

  it('without the bundle graph, warns only for a file inside a declined package', () => {
    const inside = file('node_modules/lib/index.js', { name: 'lib' });
    const outside = file('node_modules/other/index.js', {
      name: 'other',
      dependencies: { workflow: '*' },
    });
    expect(
      check({ paths: [inside], declined: [dirname(inside)] }).error
    ).toBeUndefined();
    expect(
      check({ paths: [outside], declined: [dirname(inside)] }).error
    ).toBeInstanceOf(WorkflowBuildError);
  });

  it('fails the build for the missed steps and warns for the declined ones', () => {
    const workflow = file('apps/web/workflows/a.ts');
    const lib = file('node_modules/lib/index.js', { name: 'lib' });
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
            ['step//./workflows/a//doWork', new Set([workflow])],
            ['step//lib@1.0.0//unusedStep', new Set([lib])],
          ]),
          discoveredFiles: new Set([workflow]),
          declinedPackageRoots: new Set([dirname(lib)]),
          workflowBundleGraph: {
            metafile: graph({ [workflow]: [lib], [lib]: [] }),
            workingDir: app,
          },
          workingDir: app,
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
    expect(check({ paths: [] }).error).toBeInstanceOf(WorkflowBuildError);
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
