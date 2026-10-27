/**
 * world-sim's in-band writer fence against the conformance suite every
 * World shares, so the simulator refuses and counts exactly as world-local and
 * world-postgres do.
 */

import { IN_BAND_SEQ_AT_RUN_CREATION } from '@workflow/world';
import { inBandFenceConformance } from '../../world/src/test-support/in-band-fence-conformance.js';
import { createIdFactory } from './ids.js';
import { createSimStore } from './store.js';
import { createSimWorld } from './world.js';

inBandFenceConformance({
  name: 'world-sim',
  events: () => {
    const now = 1_704_067_200_000;
    return createSimStore({
      now: () => now,
      ids: createIdFactory(() => now),
    }).events;
  },
  capabilities: () => createSimWorld().capabilities,
  // The store mints the run id.
  newRunId: () => null,
  atRunCreation: IN_BAND_SEQ_AT_RUN_CREATION,
});
