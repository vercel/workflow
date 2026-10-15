import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'stale-read-step-count-fork-fenced',
  name: 'stale read on a successor while a stalled orchestrator holds its timeout',
  description:
    'The shape of the stale-read fork above, with two orchestrators. The ' +
    'first is held with its `wait_completed` produced but not committed, its ' +
    'lease expires, and the hook commits at position 7, withheld from the ' +
    'next read. The redelivered message starts a successor whose load lags: ' +
    'it holds neither the hook nor a timeout, so it writes its own ' +
    '`wait_completed`. Its in-band count is current, so the fence accepts it, ' +
    'at position 8, and the skipped-slot report on that write hands back the ' +
    'hook at 7: the successor folds it in, the hook wins the race as the log ' +
    'records, and the run takes the recovery branch. The predecessor’s ' +
    '`wait_completed` then carries a count the successor has moved past and ' +
    'is refused (412 `in-band-superseded`). A lagging read is corrected by ' +
    'the skipped-slot report, never by a refusal; the fence only stops the ' +
    'second orchestrator. This replaces a scenario that played the stale read ' +
    'against an out-of-band watermark guard with a single delivery.',
  workflow: 'stepCountForkWorkflow',
  input: ['doc-24'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    sim.check(
      'the stalled delivery’s lease expired and its message is pending again',
      sim.expireLease({ redeliver: true }) === 1
    );

    // The hook commits, hidden from the read the successor starts with.
    sim.withholdNextEvent(1);
    await sim.deliverHook('count:doc-24', { approved: true });

    const successorDone = sim.until({ eventType: 'run_completed' });
    const redelivered = sim.deliverQueued();
    await successorDone;
    sim.check(
      'the successor finished the run while the predecessor was stalled',
      sim.world.run(sim.runId)?.status === 'completed' && wf.isHeld()
    );

    const refused = sim.until({ eventType: 'wait_completed', failed: true });
    await wf.release();
    const refusal = await refused;
    sim.check(
      'the fence refused the predecessor’s stale timeout',
      (refusal.error as { name?: string } | undefined)?.name ===
        'InBandSupersededError'
    );
    sim.check('the redelivery ran', await redelivered);

    const events = sim.world.events();
    const at = (type: string) => events.findIndex((e) => e.eventType === type);
    sim.check(
      'the log holds one timeout, the successor’s, after the hook it did not read',
      events.filter((e) => e.eventType === 'wait_completed').length === 1 &&
        at('hook_received') < at('wait_completed')
    );
    sim.check(
      'the only refusal was the predecessor’s',
      sim.world.rejections().length === 1
    );
  },
  expect: {
    status: 'completed',
    output: 'reconciled(recovered:doc-24+second)',
  },
};
