import {
  decodeFormatPrefix,
  peekFormatPrefix,
} from './serialization/format.js';
import {
  STATE_REF_REDUCER,
  STATE_SOURCE_REDUCER,
  StateContext,
} from './serialization/state-refs.js';

type Revivers = Record<string, (value: any) => any>;

/**
 * Rebuilds `workflow/state` values for inspection, without running workflow
 * code.
 *
 * With `WORKFLOW_STATE_REFS=1`, a step input can hold a reference to a version
 * stored by an earlier step, and a step output only its change. A resolver is
 * fed the run's persisted payloads once, then its revivers rebuild those values
 * for any step of the run. Keep one resolver per run and reuse it across
 * inspections instead of re-reading the run's history.
 */
export interface StateResolver {
  /**
   * Adds one persisted payload of the run, decrypted and decompressed: the run
   * input, a hook payload or a step output. Add them in event-log order. Other
   * payloads, and payloads without state records, are ignored.
   */
  add(data: unknown): void;
  /**
   * Revivers that rebuild references and changes from what was added. Merge
   * them over the revivers you hydrate with, for example
   * `{ ...observabilityRevivers, ...resolver.revivers }`. A value whose records
   * were not added displays as a placeholder.
   */
  readonly revivers: Revivers;
  /**
   * How many values the revivers could not rebuild because their records were
   * not added yet. When it grows after hydrating a value, add the run's newer
   * payloads and hydrate the value again.
   */
  readonly unresolved: number;
}

/**
 * @param revivers - The revivers you hydrate with (for example
 *   `observabilityRevivers` and your own), so values inside state decode the
 *   same way they display elsewhere.
 */
export function createStateResolver(revivers: Revivers = {}): StateResolver {
  const context = new StateContext();
  context.allowPlaceholders = true;
  let unresolved = 0;
  const placeholder = (record: Record<string, unknown>) =>
    record.kind === 'source' || record.kind === 'full'
      ? record.value
      : `<workflow/state ${String(record.version)}>`;
  return {
    get unresolved() {
      return unresolved;
    },
    add(data) {
      if (!(data instanceof Uint8Array) || peekFormatPrefix(data) !== 'devl')
        return;
      try {
        context.ingest(decodeFormatPrefix(data).payload, revivers);
      } catch {
        // A payload that cannot be read leaves later values as placeholders.
      }
    },
    revivers: {
      [STATE_REF_REDUCER]: (record: Record<string, unknown>) => {
        try {
          return context.revive(record);
        } catch {
          unresolved++;
          return placeholder(record);
        }
      },
      [STATE_SOURCE_REDUCER]: context.reviveSourceRef,
    },
  };
}
