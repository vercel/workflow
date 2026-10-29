/**
 * Thrown when the build registered fewer workflows than the app can start.
 *
 * Declared here rather than taken from `@workflow/errors`: this package is
 * CommonJS, because plenty of apps still write `next.config.js` that way, and
 * `@workflow/errors` is ESM-only. Reaching it would mean the dynamic-import
 * dance `builder-eager.ts` does for `@workflow/builders`, which is more
 * machinery than one error class is worth.
 */
export class WorkflowRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRegistrationError';
  }
}

export type RegistrationCheckMode = 'error' | 'warn' | 'off';

/**
 * What a production build does about a workflow the app can start but this
 * build did not register.
 *
 * Defaults to failing. The configuration it reports already fails every run of
 * that workflow, and a warning inside a build that reports success is exactly
 * how such a configuration ships unnoticed.
 */
export function resolveRegistrationCheckMode(
  env: NodeJS.ProcessEnv = process.env
): RegistrationCheckMode {
  switch (env.WORKFLOW_REGISTRATION_CHECK?.toLowerCase()) {
    case 'off':
    case '0':
    case 'false':
      return 'off';
    case 'warn':
      return 'warn';
    case 'error':
    case '1':
    case 'true':
      return 'error';
    default:
      // Dependency discovery is opt-out, and opting out means deliberately
      // leaving a dependency's workflows unregistered while the host bundler
      // still compiles them. Failing the build over the consequence of a flag
      // the app set would be the check arguing with its own configuration, so
      // it reports and lets the build through.
      return isNodeModulesDiscoveryDisabled(env) ? 'warn' : 'error';
  }
}

function isNodeModulesDiscoveryDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.WORKFLOW_DISCOVER_NODE_MODULES?.toLowerCase();
  return value === '0' || value === 'false';
}

/** Guidance appended to a failure, naming the usual cause and the way out. */
export const REGISTRATION_FAILURE_GUIDANCE =
  'Workflow discovery walks the import graph from your Next.js entrypoints and only follows literal\n' +
  'string specifiers, so this usually means it could not reach the file: check that every import on\n' +
  'the way to the workflow is a literal specifier, and look for earlier warnings about imports that\n' +
  'could not be resolved.\n' +
  'Set WORKFLOW_REGISTRATION_CHECK=warn to report this without failing the build.';
