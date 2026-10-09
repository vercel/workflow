/**
 * The single-owner execution model (experimental).
 *
 * A caller opts a run in at `start()` with the reserved run attribute
 * `$experimentalSingleOwner` (passing `allowReservedAttributes: true`):
 *
 *     start(workflow, args, {
 *       attributes: { $experimentalSingleOwner: '{}' },
 *       allowReservedAttributes: true,
 *     });
 *
 * The attribute's presence is the only marker. Such a run has exactly one
 * owner process at a time: every input is invoked on it, it keeps the
 * workflow resident, and it writes the run's history through the World's
 * single-writer session. A run without it executes as before.
 *
 * The value is opaque to core: the World may route by it (for example, to
 * place several runs on one owner).
 */
export const SINGLE_OWNER_ATTRIBUTE = '$experimentalSingleOwner';

/** Whether a run, or a run's initial attributes, carry the marker. */
export function isSingleOwnerRun(
  run: { attributes?: Record<string, unknown> } | null | undefined
): boolean {
  return typeof run?.attributes?.[SINGLE_OWNER_ATTRIBUTE] === 'string';
}
