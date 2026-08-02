export const VERCEL_FUNCTION_MAX_DURATION_ENV = 'VERCEL_FUNCTION_MAX_DURATION';

/**
 * Resolved per-function platform `maxDuration` (seconds), when the deployment
 * injects {@link VERCEL_FUNCTION_MAX_DURATION_ENV} at provision time.
 *
 * Returns `undefined` on local dev, self-hosted, or any runtime that does
 * not set the env var — callers fall back to static defaults.
 */
export function getPlatformMaxDurationSeconds(): number | undefined {
  const raw = process.env[VERCEL_FUNCTION_MAX_DURATION_ENV];
  if (raw === undefined || raw === '') {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}
