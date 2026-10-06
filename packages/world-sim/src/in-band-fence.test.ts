/**
 * world-sim's in-band writer fence against the conformance suite every fenced
 * World shares, so the simulator refuses and counts exactly as world-local and
 * world-postgres do.
 */

import { inBandFenceConformance } from '../../world/src/test-support/in-band-fence-conformance.js';
import { createIdFactory } from './ids.js';
import { createSimStore, IN_BAND_SEQ_AT_RUN_CREATION } from './store.js';

inBandFenceConformance({
  name: 'world-sim',
  events: () => {
    const now = 1_704_067_200_000;
    return createSimStore({
      now: () => now,
      ids: createIdFactory(() => now),
    }).events;
  },
  // The store mints the run id.
  newRunId: () => null,
  atRunCreation: IN_BAND_SEQ_AT_RUN_CREATION,
});
