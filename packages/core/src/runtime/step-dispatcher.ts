import type { Step } from '@workflow/world';

/** A step whose `step_started` the owner has committed (staged on its ordered
 * single-writer stream), with the started state that commit returned. */
export interface AdmittedStart {
  step: Step;
  claimed?: Step & { startedAt: Date };
}

/** What the dispatcher needs from the owner; it never commits events itself. */
export interface StepDispatcherHost {
  /** Bodies this process may still start itself. */
  localSlotsFree(): number;
  /** Start a body in this process. */
  startLocal(step: Step, claimed?: Step & { startedAt: Date }): void;
  /** The owner's durability barrier: everything staged so far is committed. */
  flush(): Promise<void>;
  /** The committed started state of an admitted step, after `flush`. */
  durableStart(entry: AdmittedStart): Step & { startedAt: Date };
  /** Deliver bodies to other invocations. */
  dispatchRemote(
    steps: Array<Step & { startedAt: Date }>,
    attemptTimeoutMs: number
  ): Promise<void>;
}

/**
 * Turns admitted step starts into running work, separately from the owner's
 * commit loop: the loop commits `step_started` for a prefix of admitted
 * steps and hands the prefix here, then carries on committing.
 *
 * Local bodies start as soon as their `step_started` is staged: the stream is
 * ordered and pinned, so the start commits before anything the body produces,
 * and if persistence fails the owner faults and the body's result is never
 * acknowledged. Bodies for other invocations wait for the durable prefix.
 */
export class StepDispatcher {
  constructor(private readonly host: StepDispatcherHost) {}

  async launch(chunk: AdmittedStart[], attemptTimeoutMs: number) {
    if (!chunk.length) return;
    const remote: AdmittedStart[] = [];
    let localSlots = this.host.localSlotsFree();
    for (const entry of chunk) {
      if (localSlots-- <= 0) remote.push(entry);
      else this.host.startLocal(entry.step, entry.claimed);
    }
    await this.host.flush();
    if (!remote.length) return;
    await this.host.dispatchRemote(
      remote.map((entry) => this.host.durableStart(entry)),
      attemptTimeoutMs
    );
  }
}
