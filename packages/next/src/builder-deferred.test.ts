import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNextBuilderDeferred } from './builder-deferred.js';

const tempDirs: string[] = [];
// biome-ignore lint/security/noGlobalEval: The test preserves the builder's dynamic import shim while stubbing one import.
const originalEval = globalThis.eval;

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
  vi.unstubAllGlobals();
});

describe('NextDeferredBuilder', () => {
  it('lets Next bundle step registrations from source imports', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'workflow-next-deferred-'));
    tempDirs.push(workingDir);
    vi.stubGlobal('eval', (source: string) => {
      if (source === 'import("@workflow/builders")') {
        return import('@workflow/builders');
      }
      return originalEval(source);
    });

    const NextDeferredBuilder = await getNextBuilderDeferred();
    const builder = new NextDeferredBuilder({
      dirs: [],
      workingDir,
      buildTarget: 'next',
      workflowsBundlePath: '',
      stepsBundlePath: '',
      webhookBundlePath: '',
    }) as any;

    const workflowFile = join(workingDir, 'workflows/example.ts');
    const routeDir = join(workingDir, 'app/.well-known/workflow/v1/flow');
    const flowOutfile = join(routeDir, 'route.js.temp');
    const stepManifest = {
      steps: {
        'workflows/example.ts': {
          step: { stepId: 'step//./workflows/example//step' },
        },
      },
    };
    const workflowManifest = {
      workflows: {
        'workflows/example.ts': {
          run: { workflowId: 'workflow//./workflows/example//run' },
        },
      },
    };

    builder.createStepsBundle = vi.fn();
    builder.createWorkflowsBundle = vi.fn(async () => ({
      interimBundleText: 'globalThis.__private_workflows = new Map();',
      manifest: workflowManifest,
    }));
    builder.createDeferredStepManifest = vi.fn(async () => stepManifest);

    const result = await builder.createDeferredFlowRoute({
      inputFiles: [workflowFile],
      flowOutfile,
      discoveredEntries: {
        discoveredSteps: new Set([workflowFile]),
        discoveredWorkflows: new Set([workflowFile]),
        discoveredSerdeFiles: new Set(),
      },
    });

    expect(builder.createStepsBundle).not.toHaveBeenCalled();
    expect(result.manifest).toEqual({
      ...stepManifest,
      workflows: workflowManifest.workflows,
      classes: {},
    });

    const routeCode = await readFile(flowOutfile, 'utf8');
    const expectedStepImport = relative(routeDir, workflowFile).replace(
      /\\/g,
      '/'
    );
    expect(routeCode).toContain("import 'workflow/internal/builtins';");
    expect(routeCode).toContain(`import "${expectedStepImport}";`);
    expect(routeCode).toContain(
      "import { workflowEntrypoint } from 'workflow/runtime';"
    );
    expect(routeCode).not.toContain('__step_registrations');
  });

  it('imports workspace package step sources from dist output outside packages directories', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'workflow-next-deferred-'));
    tempDirs.push(workingDir);
    vi.stubGlobal('eval', (source: string) => {
      if (source === 'import("@workflow/builders")') {
        return import('@workflow/builders');
      }
      return originalEval(source);
    });

    const NextDeferredBuilder = await getNextBuilderDeferred();
    const builder = new NextDeferredBuilder({
      dirs: [],
      workingDir,
      buildTarget: 'next',
      workflowsBundlePath: '',
      stepsBundlePath: '',
      webhookBundlePath: '',
    }) as any;

    const packageDir = join(workingDir, '../libs/demo');
    const packageSourceFile = join(packageDir, 'src/runtime/run.ts');
    const packageDistFile = join(packageDir, 'dist/runtime/run.js');
    const routeDir = join(workingDir, 'app/.well-known/workflow/v1/flow');
    await mkdir(join(packageDir, 'src/runtime'), { recursive: true });
    await mkdir(join(packageDir, 'dist/runtime'), { recursive: true });
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: '@demo/workflow-steps', type: 'module' })
    );
    await writeFile(packageSourceFile, 'export async function step() {}');
    await writeFile(packageDistFile, 'export async function step() {}');

    const importSpecifier = await builder.getDeferredRouteImportSpecifier(
      packageSourceFile,
      routeDir
    );

    expect(importSpecifier).toBe(
      relative(routeDir, packageDistFile).replace(/\\/g, '/')
    );
  });
});
