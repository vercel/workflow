import { globalSingleton } from '@workflow/utils';

/**
 * `hook_created` writes the suspension handler issued but did not wait for
 * before letting inline step bodies run, by hook token.
 *
 * The suspension handler defers the join on a workflow `AbortController`'s
 * system-hook creation so the step body can start off the step claim alone
 * (see `isDeferAbortHookCreationEnabled`). A body that was handed the
 * controller itself can call `abort()` while that creation is still in
 * flight, and the step-side abort resumes the hook by token: posted before the
 * hook exists, it would fail with `HookNotFoundError`, which the abort path
 * swallows, losing the durable record of the abort. The step-side abort awaits
 * the entry here first, so it can never overtake its hook's creation in this
 * process.
 *
 * On `globalThis` rather than at module scope: the suspension handler and the
 * step-side reviver can sit in different bundler-layer copies of this package
 * in one process, and a per-copy map would be a deterministic miss.
 */
const pending = globalSingleton(
  '@workflow/core//pendingHookCreations',
  1,
  () => new Map<string, Promise<unknown>>()
);

/**
 * Record `creation` as the in-flight `hook_created` write for `token` until it
 * settles. Never rejects and never leaves a rejection unhandled.
 */
export function trackPendingHookCreation(
  token: string,
  creation: Promise<unknown>
): void {
  const settled = creation.then(
    () => undefined,
    () => undefined
  );
  pending.set(token, settled);
  void settled.then(() => {
    if (pending.get(token) === settled) pending.delete(token);
  });
}

/**
 * Resolves once the in-flight `hook_created` write for `token` (if any) has
 * settled, whether it committed or failed. `undefined` when there is none, so
 * callers on the common path do not pay a microtask.
 */
export function pendingHookCreation(
  token: string
): Promise<unknown> | undefined {
  return pending.get(token);
}
