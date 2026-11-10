import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workflowRoutePrefixDirectory } from './route-prefix.js';

/**
 * The module specifier an API route imports to load the app's flow entry (its
 * workflows, steps and orchestrator handler) for
 * `start(..., { experimental_inline: true })`. `withWorkflow()` aliases it to
 * the generated flow route; elsewhere it resolves to an empty module, so
 * `start()` keeps queueing.
 */
export const INLINE_ENTRY_SPECIFIER = 'workflow/next/inline';

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
 * The generated flow route that {@link INLINE_ENTRY_SPECIFIER} resolves to,
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
  return join(workflowGeneratedDirectory(appDir, routePrefix), 'flow/route.js');
}
