/**
 * Whether the CLI runs as a Vercel CLI extension, as `vercel workflow`.
 *
 * Vercel CLI runs `node_modules/.bin/vercel-workflow`, whose entry point calls
 * {@link setRunAsVercelExtension} before any command loads. Run that way:
 *
 * - `--backend` defaults to `vercel` instead of `local`.
 * - Requests to the Vercel API go through the API proxy Vercel CLI starts for
 *   its extensions (passed in `VERCEL_API`), which authenticates them with
 *   the user's Vercel CLI login, so the CLI needs no token of its own.
 *
 * This is held in the process rather than an environment variable so that it
 * only changes the CLI's defaults and never leaks into child processes or into
 * code that reads `WORKFLOW_TARGET_WORLD` (such as `workflow build`).
 */
let extension: { apiUrl: string | undefined } | undefined;

export function setRunAsVercelExtension(apiUrl?: string): void {
  extension = { apiUrl: apiUrl || undefined };
}

/** Reset to a plain `workflow` invocation. For tests. */
export function resetVercelExtension(): void {
  extension = undefined;
}

/** The backend used when neither `--backend` nor `WORKFLOW_TARGET_WORLD` is set. */
export function getDefaultBackend(): string {
  return extension ? 'vercel' : 'local';
}

/**
 * The Vercel CLI extension API proxy URL, when the CLI runs as `vercel
 * workflow` and Vercel CLI provided one.
 */
export function getVercelExtensionApiUrl(): string | undefined {
  return extension?.apiUrl;
}
