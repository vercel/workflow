import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNextBuilderDeferred } from './builder-deferred.js';
import {
  DEFERRED_STEP_COPY_DIR_NAME,
  parseDeferredStepSourceMetadata,
} from './step-copy-utils.js';

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
  it('generates route imports for local, transitive, package, and built-in steps', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'workflow-next-deferred-'));
    tempDirs.push(workingDir);
    vi.stubGlobal('eval', (source: string) => {
      if (source === 'import("@workflow/builders")') {
        return import('@workflow/builders');
      }
      return originalEval(source);
    });

    const workflowFile = join(workingDir, 'workflows/example.ts');
    const localStepFile = join(workingDir, 'workflows/local-step.ts');
    const importedStepFile = join(workingDir, 'shared/imported-step.ts');
    const packageStepFile = join(
      workingDir,
      'node_modules/example-step-package/index.js'
    );
    await mkdir(join(workingDir, 'workflows'), { recursive: true });
    await mkdir(join(workingDir, 'shared'), { recursive: true });
    await mkdir(join(workingDir, 'node_modules/example-step-package'), {
      recursive: true,
    });
    await writeFile(
      workflowFile,
      `import '../shared/imported-step';\nexport async function run() {\n  'use workflow';\n}`
    );
    await writeFile(
      localStepFile,
      `export async function localStep() {\n  'use step';\n}`
    );
    await writeFile(
      importedStepFile,
      `export async function importedStep() {\n  'use step';\n}`
    );
    await writeFile(
      packageStepFile,
      `export async function packageStep() {\n  'use step';\n}`
    );

    const NextDeferredBuilder = await getNextBuilderDeferred();
    const builder = new NextDeferredBuilder({
      dirs: [],
      workingDir,
      buildTarget: 'next',
      workflowsBundlePath: '',
      stepsBundlePath: '',
      webhookBundlePath: '',
    }) as any;
    builder.createDeferredStepsManifest = vi.fn(async () => ({}));

    const workflowGeneratedDir = join(
      workingDir,
      'app/.well-known/workflow/v1'
    );
    await builder.buildStepsFunction({
      workflowGeneratedDir,
      discoveredEntries: {
        discoveredSteps: [localStepFile, packageStepFile],
        discoveredWorkflows: [workflowFile],
        discoveredSerdeFiles: [],
      },
    });

    const stepRouteDir = join(workflowGeneratedDir, 'step');
    const copiedStepsDir = join(stepRouteDir, DEFERRED_STEP_COPY_DIR_NAME);
    const copiedFileNames = await readdir(copiedStepsDir);
    const copiedSources = await Promise.all(
      copiedFileNames.map(async (fileName) => ({
        fileName,
        source: await readFile(join(copiedStepsDir, fileName), 'utf-8'),
      }))
    );
    const copiedSourcePaths = copiedSources
      .map(
        ({ source }) => parseDeferredStepSourceMetadata(source)?.absolutePath
      )
      .filter((path): path is string => Boolean(path));

    expect(copiedSourcePaths).toEqual(
      expect.arrayContaining([localStepFile, importedStepFile, packageStepFile])
    );
    expect(
      copiedSources.some(({ source }) =>
        source.includes('__builtin_response_array_buffer')
      )
    ).toBe(true);

    const routeCode = await readFile(join(stepRouteDir, 'route.js'), 'utf-8');
    for (const { fileName } of copiedSources) {
      expect(routeCode).toContain(
        `import './${DEFERRED_STEP_COPY_DIR_NAME}/${fileName}';`
      );
    }
    expect(routeCode).toContain(
      "export { stepEntrypoint as HEAD, stepEntrypoint as POST } from 'workflow/runtime';"
    );
  });
});
