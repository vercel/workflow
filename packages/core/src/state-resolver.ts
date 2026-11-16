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
 * Rebuilds frozen state stored by reference for inspection, without running workflow
 * code.
 *
 * A step input can hold a reference to a frozen value
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
   *
   * Pass `source` for the run input and hook payloads: the id later state
   * may refer to their strings by, from `stateSourceId('run-input')` or
   * `stateSourceId(event)`.
   */
  add(data: unknown, source?: string): void;
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
  return {
    get unresolved() {
      return unresolved;
    },
    add(data, source) {
      if (!(data instanceof Uint8Array) || peekFormatPrefix(data) !== 'devl')
        return;
      try {
        context.ingest(decodeFormatPrefix(data).payload, revivers, source);
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
          return context.placeholderFor(record);
        }
      },
      [STATE_SOURCE_REDUCER]: context.reviveSourceRef,
    },
  };
}
