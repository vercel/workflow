import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const localRequire = createRequire(import.meta.url);
const WORKFLOW_RUNTIME_SPECIFIER = ['workflow', 'runtime'].join('/');
const CORE_RUNTIME_SPECIFIER = ['@workflow', 'core', 'runtime'].join('/');

export type RuntimeRequire = typeof localRequire;

export function getProjectRequire(): RuntimeRequire {
  try {
    return createRequire(
      pathToFileURL(
        resolve(/* turbopackIgnore: true */ process.cwd(), 'package.json')
      ).href
    );
  } catch {
    return localRequire;
  }
}

export function getCoreRuntimeRequire(): RuntimeRequire {
  const projectRequire = getProjectRequire();

  try {
    const workflowRuntimePath = projectRequire.resolve(
      WORKFLOW_RUNTIME_SPECIFIER
    );
    const workflowRuntimeRequire = createRequire(
      pathToFileURL(workflowRuntimePath).href
    );
    const coreRuntimePath = workflowRuntimeRequire.resolve(
      CORE_RUNTIME_SPECIFIER
    );

    return createRequire(pathToFileURL(coreRuntimePath).href);
  } catch {
    return localRequire;
  }
}
