/**
 * The inline steps one workflow delivery is executing, across passes of its
 * replay loop.
 *
 * The inline loop runs a batch of steps in parallel. Waiting for the whole
 * batch before replaying makes parallel branches advance in lockstep: a branch
 * whose step settled cannot start its next step until the slowest sibling
 * settles. With early advance (`isInlineEarlyAdvanceEnabled`), the loop
 * instead replays as soon as one step settles cleanly, and the steps still
 * running stay here, owned by this delivery, until a later pass collects them.
 *
 * Every tracked step is settled before the delivery acknowledges its message,
 * since crash recovery of an inline-owned step depends on the owning message
 * being redelivered.
 */

export interface InlineStepSettlement<Step, Result> {
  step: Step;
  outcome: PromiseSettledResult<Result>;
}

interface Entry<Step, Result> {
  step: Step;
  /** Resolves (never rejects) once the execution settled. */
  done: Promise<void>;
  /** Resolves once the step's claim settled, or the execution did. */
  startSettled: Promise<void>;
  outcome?: PromiseSettledResult<Result>;
}

export interface InlineSettlementRound<Step, Result> {
  /**
   * The loop may replay now with the remaining steps still running: every
   * settled step settled cleanly, at least one step is still running, and
   * every running step's claim has settled.
   */
  early: boolean;
  /** The settled steps, removed from tracking, in the order they started. */
  settled: InlineStepSettlement<Step, Result>[];
}

export class InlineStepsInFlight<
  Step extends { correlationId: string },
  Result,
> {
  readonly #entries = new Map<string, Entry<Step, Result>>();
  readonly #ids = new Set<string>();

  /**
   * Correlation ids of every tracked step, settled or not, until a settlement
   * round takes it. A replay pass must leave these steps alone: one whose
   * execution settled after the pass loaded its log still reads as pending
   * there, owned by this delivery.
   */
  get ids(): ReadonlySet<string> {
    return this.#ids;
  }

  get size(): number {
    return this.#entries.size;
  }

  track(step: Step, execution: Promise<Result>, startSettled: Promise<void>) {
    const entry: Entry<Step, Result> = {
      step,
      done: execution.then(
        (value) => {
          entry.outcome = { status: 'fulfilled', value };
        },
        (reason: unknown) => {
          entry.outcome = { status: 'rejected', reason };
        }
      ),
      startSettled: Promise.race([startSettled, execution]).then(
        () => {},
        () => {}
      ),
    };
    this.#entries.set(step.correlationId, entry);
    this.#ids.add(step.correlationId);
  }

  /**
   * Wait until at least one tracked step settled. With `allowEarly`, return
   * early when every settled step passes `isClean` and some step is still
   * running; otherwise wait for every tracked step.
   *
   * Before returning early, waits for every running step's claim to settle,
   * so a step this delivery is executing is durably started before the next
   * pass can create a hook or wait and let a concurrent delivery replay.
   */
  async settle(
    allowEarly: boolean,
    isClean: (outcome: PromiseSettledResult<Result>) => boolean
  ): Promise<InlineSettlementRound<Step, Result>> {
    if (this.#entries.size === 0) return { early: false, settled: [] };
    await Promise.race([...this.#entries.values()].map((e) => e.done));
    if (allowEarly && this.#canAdvanceEarly(isClean)) {
      await Promise.all([...this.#entries.values()].map((e) => e.startSettled));
      if (this.#canAdvanceEarly(isClean)) {
        return { early: true, settled: this.#take((e) => !!e.outcome) };
      }
    }
    return { early: false, settled: await this.settleAll() };
  }

  /**
   * Remove every tracked step if all of them already settled and pass
   * `isClean`, and report whether it did. Nothing is waited for: a step that
   * settled cleanly wrote its terminal event and needs nothing more.
   */
  takeIfAllSettled(
    isClean: (outcome: PromiseSettledResult<Result>) => boolean
  ): boolean {
    for (const entry of this.#entries.values()) {
      if (!entry.outcome || !isClean(entry.outcome)) return false;
    }
    this.#take(() => true);
    return true;
  }

  /** Wait for every tracked step and remove them all from tracking. */
  async settleAll(): Promise<InlineStepSettlement<Step, Result>[]> {
    await Promise.all([...this.#entries.values()].map((e) => e.done));
    return this.#take(() => true);
  }

  #canAdvanceEarly(
    isClean: (outcome: PromiseSettledResult<Result>) => boolean
  ): boolean {
    let settled = 0;
    for (const entry of this.#entries.values()) {
      if (!entry.outcome) continue;
      if (!isClean(entry.outcome)) return false;
      settled++;
    }
    return settled > 0 && settled < this.#entries.size;
  }

  #take(
    predicate: (entry: Entry<Step, Result>) => boolean
  ): InlineStepSettlement<Step, Result>[] {
    const taken: InlineStepSettlement<Step, Result>[] = [];
    for (const [id, entry] of this.#entries) {
      if (!predicate(entry) || !entry.outcome) continue;
      taken.push({ step: entry.step, outcome: entry.outcome });
      this.#entries.delete(id);
      this.#ids.delete(id);
    }
    return taken;
  }
}
