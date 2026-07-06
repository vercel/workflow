/**
 * Helpers for resolving numeric runtime-tuning constants from environment
 * variables.
 *
 * Several SDK constants (timeouts, retry counts, stream buffering, …) are
 * useful to tune per-deployment — most notably to dial them down on a
 * dedicated e2e deployment so the test suite exercises edge paths (reconnects,
 * batch splitting, retries) that otherwise only trigger after long durations
 * or large payloads.
 *
 * `envNumber` reads `process.env[name]` lazily (so tests and deployments can
 * override per invocation), clamps to an optional `[min, max]` range, and
 * never throws — an env override is an escape hatch, not a hard requirement,
 * so an invalid value falls back to the constant's compiled-in default. A
 * misconfigured value warns once per process so the mistake is observable
 * without spamming logs.
 */

export interface EnvNumberOptions {
  /** Inclusive lower bound; values below are clamped up to it. Default 0. */
  min?: number;
  /** Inclusive upper bound; values above are clamped down to it. */
  max?: number;
  /** Require an integer; fractional values fall back to the default. */
  integer?: boolean;
}

// Raw "name=value" pairs already warned about, so a bad env var warns once
// per process rather than on every (lazy) read.
const warnedEnvValues = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedEnvValues.has(key)) return;
  warnedEnvValues.add(key);
  // `@workflow/world` has no logger dependency; match the package's existing
  // use of console.warn for non-fatal misconfiguration notices.
  console.warn(`[workflow] ${message}`);
}

/**
 * Resolve a numeric tuning constant from `process.env[name]`, falling back to
 * `fallback` when the variable is unset, empty, or invalid. Clamps to
 * `[min, max]` when provided.
 */
export function envNumber(
  name: string,
  fallback: number,
  options: EnvNumberOptions = {}
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const { min = 0, max, integer = false } = options;
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    warnOnce(
      `${name}=${raw}`,
      `Ignoring ${name}: not a ${integer ? 'finite integer' : 'finite number'}; using default ${fallback}`
    );
    return fallback;
  }

  if (parsed < min) {
    warnOnce(`${name}=${raw}`, `${name} below minimum ${min}; clamped`);
    return min;
  }
  if (max !== undefined && parsed > max) {
    warnOnce(`${name}=${raw}`, `${name} above maximum ${max}; clamped`);
    return max;
  }
  return parsed;
}

/**
 * Reset the warn-once cache. Test-only — exported so unit tests can exercise
 * the warning path repeatedly without sharing state across cases.
 *
 * @internal
 */
export function _resetEnvWarnCacheForTests(): void {
  warnedEnvValues.clear();
}
