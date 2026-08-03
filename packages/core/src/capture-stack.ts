/**
 * V8-only (Node, Bun, Chrome, Deno). Rewrites `err.stack` so the top frame is
 * the caller of `stackStartFn` instead of the framework function that threw.
 * Without this, terminal overlays (Next.js, Turbopack, VS Code) render the
 * code frame at our `throw` site inside `@workflow/core`, which is useless
 * to the user.
 *
 * No-op on engines that don't expose `Error.captureStackTrace` — the stack
 * degrades gracefully to the default behavior.
 *
 * Kept in its own tiny module so callers that can't participate in the
 * `context-errors.ts` ↔ `workflow/get-workflow-metadata.ts` import cycle can
 * still pull in the helper without pulling in the full error classes.
 */
export function redirectStackToCaller(
  err: Error,
  // biome-ignore lint/complexity/noBannedTypes: signature matches Error.captureStackTrace
  stackStartFn: Function
): void {
  const capture = (
    Error as unknown as {
      captureStackTrace?: (target: object, fn: Function) => void;
    }
  ).captureStackTrace;
  capture?.(err, stackStartFn);
}
