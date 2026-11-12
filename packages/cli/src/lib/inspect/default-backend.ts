/**
 * The backend used when neither `--backend` nor `WORKFLOW_TARGET_WORLD` is
 * set. It is `local`, except when the CLI runs as `vercel workflow`: the
 * `vercel-workflow` entry point sets it to `vercel` before any command loads.
 *
 * This is held in the process rather than an environment variable so that it
 * only changes the CLI's default and never leaks into child processes or into
 * code that reads `WORKFLOW_TARGET_WORLD` (such as `workflow build`).
 */
let defaultBackend = 'local';

export function getDefaultBackend(): string {
  return defaultBackend;
}

export function setDefaultBackend(backend: string): void {
  defaultBackend = backend;
}
