/**
 * Replaces `error.stack` with `stack` when the property allows it.
 *
 * Some libraries redefine `stack` on the errors they throw. postgres.js, for
 * example, uses `Object.defineProperties(err, { stack: { value } })`, which
 * turns it into a non-writable data property. Assigning to it throws a
 * `TypeError` in strict mode, and that `TypeError` would replace the user's
 * error. A non-writable `stack` that is still configurable is redefined; one
 * that cannot be changed at all keeps its original value.
 */
export function setErrorStack(error: Error, stack: string): void {
  try {
    error.stack = stack;
    return;
  } catch {
    // Non-writable. A configurable property can still be redefined.
  }
  try {
    Object.defineProperty(error, 'stack', {
      value: stack,
      writable: true,
      configurable: true,
    });
  } catch {
    // Non-configurable or frozen: keep the original stack.
  }
}
