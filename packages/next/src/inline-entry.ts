import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workflowRoutePrefixDirectory } from './route-prefix.js';

/**
 * The module `start()` and `resumeHook()` load to run a run's orchestrator
 * delivery inline (see `@workflow/core`'s `runtime/inline-orchestrator.ts`).
 * `withWorkflow()` aliases it to the generated flow route for Node.js server
 * code; elsewhere it resolves to `@workflow/core`'s empty default module, so
 * `start()` keeps queueing.
 */
export const INLINE_ENTRY_SPECIFIER = '@workflow/core/inline-entry';

function isDirectory(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) {
      throw new Error(`Path exists but is not a directory: ${path}`);
    }
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.includes('not a directory')) {
      throw e;
    }
    return false;
  }
}

/**
 * The App Router directory the workflow routes are generated into, and
 * whether it has to be created (a Pages Router app gets one next to `pages`).
 * Throws when the project has neither router.
 */
export function resolveWorkflowAppDirectory(workingDir: string): {
  dir: string;
  create: boolean;
} {
  const appDir = resolve(workingDir, 'app');
  const srcAppDir = resolve(workingDir, 'src/app');
  if (isDirectory(appDir)) return { dir: appDir, create: false };
  if (isDirectory(srcAppDir)) return { dir: srcAppDir, create: false };
  if (isDirectory(resolve(workingDir, 'pages'))) {
    return { dir: appDir, create: true };
  }
  if (isDirectory(resolve(workingDir, 'src/pages'))) {
    return { dir: srcAppDir, create: true };
  }
  throw new Error(
    'Could not find Next.js app or pages directory. Expected one of: "app", "src/app", "pages", or "src/pages" to exist.'
  );
}

/** The generated workflow routes' directory (`<app>/<prefix>/.well-known/workflow/v1`). */
export function workflowGeneratedDirectory(
  appDir: string,
  routePrefix: string | undefined
): string {
  return join(
    appDir,
    workflowRoutePrefixDirectory(routePrefix),
    '.well-known/workflow/v1'
  );
}

/**
 * The generated inline entry that {@link INLINE_ENTRY_SPECIFIER} resolves to,
 * or `undefined` when the project has no router directory to generate it in.
 */
export function inlineEntryTarget(
  workingDir: string,
  routePrefix: string | undefined
): string | undefined {
  let appDir: string;
  try {
    appDir = resolveWorkflowAppDirectory(workingDir).dir;
  } catch {
    return undefined;
  }
  return join(
    workflowGeneratedDirectory(appDir, routePrefix),
    `flow/${INLINE_VM_ENTRY_FILE}`
  );
}

/**
 * The inline entry beside the flow route: the app's workflow VM code and the
 * orchestrator handler, without the flow route's step registrations. A route
 * that runs a delivery inline runs the steps its own module graph registered
 * (Next.js compiles every module in step mode, so a route that imports a
 * workflow has its steps) and queues any other step to the flow route.
 */
export const INLINE_VM_ENTRY_FILE = 'inline-vm.js';

/** The module both the flow route and the inline entry take the code from. */
export const WORKFLOW_CODE_FILE = 'workflow-code.js';
