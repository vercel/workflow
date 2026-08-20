/**
 * Shared shape for finalizing a step whose arguments failed to serialize
 * (used by both the node:vm suspension handler and the QuickJS entrypoint).
 *
 * The world requires a `step_created` before any terminal step event, and
 * the step's real input is precisely what refused to serialize — so the
 * finalization writes a placeholder input. The marker string makes the
 * placeholder distinguishable from a genuine zero-argument step in
 * `workflow inspect steps` and the observability UI: a reader sees
 * "input unavailable" instead of "no arguments".
 */
export const UNSERIALIZABLE_STEP_INPUT_MARKER =
  '[input unavailable: step argument serialization failed]';

/**
 * Structural discriminator on the placeholder's top level. The
 * `{ args, closureVars, thisVal }` triple is built by the SDK — user code
 * never controls its top-level keys — so this flag cannot false-positive on
 * a legitimate input, unlike the display marker inside `args`.
 */
const UNSERIALIZABLE_FLAG = '__workflowUnserializableStepInput';

/**
 * The placeholder value serialized into the failed step's `step_created`
 * input. Matches the `{ args, closureVars, thisVal }` triple
 * `dehydrateStepArguments` / the QuickJS bootstrap produce for real steps,
 * so every consumer hydrates it uniformly, plus the structural flag the
 * step executor checks before running user code (see
 * {@link isUnserializableStepInputPlaceholder}).
 */
export function unserializableStepInputPlaceholder(): Record<string, unknown> {
  return {
    args: [UNSERIALIZABLE_STEP_INPUT_MARKER],
    closureVars: [],
    thisVal: undefined,
    [UNSERIALIZABLE_FLAG]: true,
  };
}

/**
 * Whether a hydrated step input is the finalization placeholder.
 *
 * Finalization writes `step_created` (placeholder) and `step_failed` as two
 * separate durable writes; a crash or transient failure between them leaves
 * a pending step whose stored input is the placeholder. Redelivery then
 * dispatches that step through normal crash recovery — the executor calls
 * this before running user code and completes the intended failure (a fatal
 * SerializationError → `step_failed`) instead of silently invoking the step
 * body with placeholder arguments.
 */
export function isUnserializableStepInputPlaceholder(
  hydratedInput: unknown
): boolean {
  return (
    typeof hydratedInput === 'object' &&
    hydratedInput !== null &&
    (hydratedInput as Record<string, unknown>)[UNSERIALIZABLE_FLAG] === true
  );
}
