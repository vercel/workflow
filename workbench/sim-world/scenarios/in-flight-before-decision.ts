import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'in-flight-before-decision',
  name: 'in-flight: hook lands while a stalled orchestrator holds its timeout, and a successor takes over',
  description:
    'The orchestrator decides the timer won the race and is held with its ' +
    '`wait_completed` produced but not committed. The webhook receiver commits ' +
    'its hook in that window, so the log records the hook first. The stalled ' +
    'delivery’s lease then expires and the same message starts a successor, ' +
    'which loads a log holding the hook and no timeout, takes the recovery ' +
    'branch and finishes the run. When the predecessor resumes, its ' +
    '`wait_completed` carries the in-band count from its own load, which the ' +
    'successor has moved past, so the fence refuses it (412 ' +
    '`in-band-superseded`): its timeout decision never lands, and the only ' +
    '`wait_completed` in the log is the successor’s, after the hook. The hook ' +
    'itself is out-of-band and is never refused. This replaces a scenario ' +
    'that checked an out-of-band watermark guard on the same tempo; on a ' +
    'single-orchestrator run the only refusal is the in-band fence, and ' +
    '`in-flight-before-decision-counted` below plays the same hook against a ' +
    'single delivery with no overlap.',
  workflow: 'stepCountForkWorkflow',
  input: ['doc-29'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');

    const hook = await sim.beginHookDelivery('count:doc-29', {
      approved: true,
    });
    sim.check(
      'the stalled delivery’s lease expired and its message is pending again',
      sim.expireLease({ redeliver: true }) === 1
    );
    await hook.commit();
    sim.check(
      'the hook landed before any timeout',
      sim.world.events().some((e) => e.eventType === 'hook_received') &&
        sim.world.events().every((e) => e.eventType !== 'wait_completed')
    );

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

    sim.check(
      'only the predecessor’s in-band write was refused',
      sim.world
        .rejections()
        .every(
          (r) =>
            r.errorName === 'InBandSupersededError' &&
            r.eventType === 'wait_completed'
        )
    );
    // The timer is due by now, so the successor completes the wait too, but
    // from a log that already holds the hook: one `wait_completed`, after it.
    const events = sim.world.events();
    const at = (type: string) => events.findIndex((e) => e.eventType === type);
    sim.check(
      'the log holds one timeout, the successor’s, after the hook',
      events.filter((e) => e.eventType === 'wait_completed').length === 1 &&
        at('hook_received') < at('wait_completed')
    );
  },
  expect: {
    status: 'completed',
    output: 'reconciled(recovered:doc-29+second)',
  },
};
