import type { Storage, WorkflowRun } from '@workflow/world';
import { IN_BAND_SEQ_AT_RUN_CREATION } from '@workflow/world';
import { strictEventCountConformance } from '../../../world/src/test-support/strict-event-count-conformance.js';
import { AppendOnlyWorld } from './append-only-world.js';

const worlds = new WeakMap<Storage['events'], AppendOnlyWorld>();
const RUN = 'wrun_strict_conformance';

strictEventCountConformance({
  name: 'AppendOnlyWorld',
  events: () => {
    const world = new AppendOnlyWorld({ strictEventCount: true });
    const { events } = world.asWorld();
    worlds.set(events, world);
    return events;
  },
  capabilities: () =>
    new AppendOnlyWorld({ strictEventCount: true }).asWorld().capabilities,
  newRunId: () => RUN,
  atRunCreation: IN_BAND_SEQ_AT_RUN_CREATION,
  createRun: async (events) => {
    worlds.get(events)?.seedRun({
      runId: RUN,
      workflowName: 'strictConformance',
      deploymentId: 'dpl_strict_conformance',
      status: 'running',
      input: new Uint8Array(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as WorkflowRun);
    return RUN;
  },
});
