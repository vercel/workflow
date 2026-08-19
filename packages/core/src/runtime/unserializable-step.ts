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
 * The placeholder value serialized into the failed step's `step_created`
 * input. Matches the `{ args, closureVars, thisVal }` triple
 * `dehydrateStepArguments` / the QuickJS bootstrap produce for real steps,
 * so every consumer hydrates it uniformly.
 */
export function unserializableStepInputPlaceholder(): {
  args: string[];
  closureVars: never[];
  thisVal: undefined;
} {
  return {
    args: [UNSERIALIZABLE_STEP_INPUT_MARKER],
    closureVars: [],
    thisVal: undefined,
  };
}
