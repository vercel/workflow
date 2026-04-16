import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const localRequire = createRequire(import.meta.url);

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
    const workflowRuntimePath = projectRequire.resolve('workflow/runtime');
    const workflowRuntimeRequire = createRequire(
      pathToFileURL(workflowRuntimePath).href
    );
    const coreRuntimePath = workflowRuntimeRequire.resolve(
      '@workflow/core/runtime'
    );

    return createRequire(pathToFileURL(coreRuntimePath).href);
  } catch {
    return localRequire;
  }
}
