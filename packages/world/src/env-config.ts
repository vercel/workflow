/**
 * Helpers for resolving numeric runtime-tuning constants from environment
 * variables.
 *
 * Several SDK constants (timeouts, retry counts, stream buffering, …) are
 * useful to tune per-deployment, most notably to dial them down on a
 * dedicated e2e deployment so the test suite exercises edge paths (reconnects,
 * batch splitting, retries) that otherwise only trigger after long durations
 * or large payloads.
 *
 * `envNumber` reads `process.env[name]` lazily (so tests and deployments can
 * override per invocation), clamps to an optional `[min, max]` range, and
 * never throws: an env override is an escape hatch, not a hard requirement,
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
//
// On `globalThis` rather than at module scope so "per process" survives
// bundling: this package is compiled into the host application's server build,
// which gives one copy of this module per bundler layer, and a per-copy Set
// would warn once per layer. Hand-rolled rather than `globalSingleton()` from
// `@workflow/utils` because this package deliberately carries no dependencies;
// the two are equivalent and the rule accepts both.
const WarnedEnvValuesKey = Symbol.for('@workflow/world//warnedEnvValues/v1');
const globalStore = globalThis as typeof globalThis &
  Record<symbol, Set<string> | undefined>;
// The same globalThis-backed idiom as `packages/core/src/private.ts`. Keeping
// the initializer an expression is also what
// `scripts/lint/module-scope-state.mjs` recognizes as off-module state.
// biome-ignore lint/suspicious/noAssignInExpressions: off-module state idiom
const warnedEnvValues = (globalStore[WarnedEnvValuesKey] ??= new Set<string>());

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
 * Resolve a boolean feature flag from `process.env[name]`.
 *
 * Matches the convention the runtime flags already use (`WORKFLOW_TURBO`,
 * `WORKFLOW_SLOT_IDENTITY`, …): unset or empty takes `fallback`, and the only
 * values that force a side are `0` / `false` and `1` / `true`
 * (case-insensitive). Anything else falls back rather than throwing (a flag is
 * an escape hatch, not a hard requirement) and warns once per process.
 */
export function envFlag(
  name: string,
  fallback: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const normalized = raw.toLowerCase();
  if (normalized === '0' || normalized === 'false') return false;
  if (normalized === '1' || normalized === 'true') return true;

  warnOnce(
    `${name}=${raw}`,
    `Ignoring ${name}: expected 0/1/true/false; using default ${fallback}`
  );
  return fallback;
}

const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

export function getMaxEventsPerRun(): number {
  const maxEvents = envNumber(
    'WORKFLOW_MAX_EVENTS',
    DEFAULT_MAX_EVENTS_PER_RUN,
    { integer: true }
  );
  return maxEvents > 0 ? maxEvents : DEFAULT_MAX_EVENTS_PER_RUN;
}

/**
 * Reset the warn-once cache. Test-only, exported so unit tests can exercise
 * the warning path repeatedly without sharing state across cases.
 *
 * @internal
 */
export function _resetEnvWarnCacheForTests(): void {
  warnedEnvValues.clear();
}
