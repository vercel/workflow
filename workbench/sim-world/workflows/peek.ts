import { createHook, setAttributes } from 'workflow';

async function reserve(documentId: string) {
  'use step';
  return `reserved:${documentId}`;
}

async function shipWithoutApproval(reservation: string) {
  'use step';
  return `shipped-unapproved:${reservation}`;
}

async function shipWithApproval(reservation: string) {
  'use step';
  return `shipped-approved:${reservation}`;
}

/**
 * Branches on whether a hook has *already* fired, without waiting for it.
 *
 * There is no peek API on `Hook`, so the way a user writes "has the approval
 * landed yet?" is to race it against an already-resolved promise. That makes
 * the branch a function of *when* the payload arrived rather than of the
 * payload itself — and "when" is the one thing a replay does not reproduce,
 * because on replay the whole log is already there.
 *
 * The hazard: if `hook_received` is committed at a log position before the
 * branch's own events, then a replay reaching this race has the payload
 * buffered and takes the other fork. The first execution shipped without
 * approval; the replay wants to ship with it, and the log says otherwise.
 */
export async function hookPeekWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `peek:${documentId}`,
  });

  const reservation = await reserve(documentId);

  const peeked = await Promise.race([
    hook.then(() => 'arrived' as const),
    Promise.resolve('not-yet' as const),
  ]);

  return peeked === 'arrived'
    ? await shipWithApproval(reservation)
    : await shipWithoutApproval(reservation);
}

async function probe(documentId: string) {
  'use step';
  return `probed:${documentId}`;
}

/**
 * The same branch, but racing the hook against a *step* rather than against an
 * already-resolved promise.
 *
 * This is the harder version. A resolved promise wins on a microtask and the
 * hook payload is deliberately deferred behind a macrotask, so the peek above
 * always reads "not yet". Here both competitors are event-log deliveries, so
 * which one wins is decided by the runtime's delivery-barrier ordering — and
 * that ordering is keyed on log position, which the cue controls.
 */
export async function hookRaceStepWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `race:${documentId}`,
  });

  const winner = await Promise.race([
    hook.then(() => 'hook' as const),
    probe(documentId).then(() => 'step' as const),
  ]);

  return winner === 'hook'
    ? await shipWithApproval(`race:${documentId}`)
    : await shipWithoutApproval(`race:${documentId}`);
}

/**
 * Two concurrent branches: one gated on a hook that then records the decision
 * as run state, one an ordinary step.
 *
 * Three delivery types land in one log here — a step result, a hook payload,
 * and an `attr_set` — and the hook's arrival time decides the order of the last
 * two relative to the first. Attributes are the only *mutable* run state a
 * workflow can write, and the world materializes them by folding the log, so
 * this is where an ordering bug would show up as a wrong final value rather
 * than as a divergence.
 */
export async function concurrentAttributeWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `attr:${documentId}`,
  });

  const [approved, probed] = await Promise.all([
    (async () => {
      const payload = await hook;
      await setAttributes({ approval: payload.approved ? 'yes' : 'no' });
      return payload.approved;
    })(),
    probe(documentId),
  ]);

  await setAttributes({ phase: 'settled' });
  return `${probed}/${approved ? 'approved' : 'rejected'}`;
}

/** Writes run state from inside a step body, not from the orchestrator. */
async function probeAndRecord(documentId: string) {
  'use step';
  await setAttributes({ probedBy: 'step', document: documentId });
  return `recorded:${documentId}`;
}

/**
 * Two concurrent steps plus a hook, where the attribute is written from *step*
 * context rather than from the orchestrator.
 *
 * A different path than `concurrentAttributeWorkflow`: an `attr_set` from a step
 * carries `writer: { type: 'step', stepId, attempt }`, is committed inline while
 * the body runs rather than batched at the next suspension, and gets no
 * correlationId dedupe — so its log position really is decided by step timing.
 */
export async function stepAttributeWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `stepattr:${documentId}`,
  });

  const [payload, recorded, probed] = await Promise.all([
    hook,
    probeAndRecord(documentId),
    probe(documentId),
  ]);

  return `${recorded}|${probed}|${payload.approved ? 'yes' : 'no'}`;
}
