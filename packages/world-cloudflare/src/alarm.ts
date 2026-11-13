/**
 * When a run object's alarm should next fire. Pure, so it can be unit-tested
 * outside workerd; `RunObject.#scheduleAlarm` feeds it the object's state.
 */

/** What the alarm needs to know about one stored signal. */
export interface AlarmSignal {
  kind: 'flow' | 'step';
  /** Epoch ms at which the signal is due. */
  runAt: number;
  /** Redelivery was abandoned; nothing will run it. */
  parked: boolean;
  /** A delivery of it is running in this instance. */
  inflight: boolean;
  /** Held for another build; only re-checked occasionally. */
  pinned: boolean;
}

export interface AlarmInput {
  now: number;
  signals: Iterable<AlarmSignal>;
  /** Deadlines of open waits (epoch ms), while the run is not terminal. */
  waitDeadlines: Iterable<number>;
  /** A flow delivery is running, so no other flow signal can start. */
  flowBusy: boolean;
  /** Every step delivery slot is taken, so no other step signal can start. */
  stepSlotsFull: boolean;
  /** Deliveries running in this instance. */
  inflightCount: number;
  /** Re-arm interval while deliveries are in flight. */
  backstopMs: number;
  /** Re-check interval for pinned signals. */
  pinnedRecheckMs: number;
}

/** Epoch ms for the next alarm, or `null` when nothing needs one. */
export function computeAlarmTarget(input: AlarmInput): number | null {
  const { now } = input;
  let next: number | undefined;
  const consider = (ms: number) => {
    if (next === undefined || ms < next) next = ms;
  };
  for (const signal of input.signals) {
    if (signal.parked || signal.inflight) continue;
    if (signal.pinned) {
      consider(now + input.pinnedRecheckMs);
      continue;
    }
    // A due signal that cannot start for lack of capacity needs no alarm of
    // its own: the delivery occupying that capacity re-drives the object when
    // it settles, and the in-flight backstop below covers that delivery being
    // lost. Arming at its (past) `runAt` would fire the alarm again at once,
    // in a loop, for as long as the delivery runs.
    const blocked =
      signal.kind === 'flow' ? input.flowBusy : input.stepSlotsFull;
    if (signal.runAt <= now && blocked) continue;
    consider(signal.runAt);
  }
  for (const deadline of input.waitDeadlines) consider(deadline);
  if (input.inflightCount > 0) consider(now + input.backstopMs);
  return next ?? null;
}
