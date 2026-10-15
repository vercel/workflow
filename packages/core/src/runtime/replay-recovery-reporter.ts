import type { CreateEventParams } from '@workflow/world';

/**
 * Invocation-scoped, one-shot reporter for a replay-divergence recovery.
 *
 * The reporter stays dormant until replay reaches a valid deterministic
 * boundary. The first subsequent event write carries the telemetry for free.
 * A recovered invocation with no natural event write intentionally reports
 * nothing.
 */
export class ReplayRecoveryReporter {
  private active = false;
  private reported = false;
  private recovered = false;

  constructor(private readonly divergenceCount: number) {}

  /**
   * The count a divergence raised by this invocation belongs to.
   *
   * Until a natural write has carried the recovery telemetry, the invocation
   * is still inside the episode it was enqueued to recover, so the count
   * continues from the incoming one. A committed write after a clean replay
   * proves that episode over (the divergence was not reproducible against
   * this log), so a later divergence in the same invocation opens a new
   * episode at 1 instead of spending the old one's budget. An inert reporter
   * has no incoming episode and always answers 1.
   */
  nextDivergenceCount(): number {
    return this.recovered ? 1 : this.divergenceCount + 1;
  }

  /**
   * A reporter for an invocation that never diverged: `activate()` cannot arm
   * it, so `withEventCreate` always passes writes through untouched. Lets every
   * call site hold a non-optional reporter instead of branching on one.
   *
   * Structurally inert rather than a zero-count reporter on purpose: the
   * server rejects a count below 1 as out-of-range and emits a
   * `telemetry_rejected` metric, so a reporter that *can* report zero is a
   * live footgun.
   */
  static inert(): ReplayRecoveryReporter {
    return new InertReplayRecoveryReporter();
  }

  activate(): void {
    this.active = true;
  }

  /**
   * Decorate one natural event write with recovery telemetry.
   *
   * The claim is taken synchronously, so concurrent suspension writes cannot
   * all carry the same count. A failed request releases it for a later natural
   * write in the same invocation.
   */
  async withEventCreate<T>(
    params: CreateEventParams | undefined,
    create: (params: CreateEventParams | undefined) => Promise<T>
  ): Promise<T> {
    if (!this.active || this.reported) return create(params);

    this.reported = true;
    try {
      const result = await create({
        ...params,
        replayDivergenceCount: this.divergenceCount,
      });
      this.recovered = true;
      return result;
    } catch (error) {
      this.reported = false;
      throw error;
    }
  }
}

/** See {@link ReplayRecoveryReporter.inert}. */
class InertReplayRecoveryReporter extends ReplayRecoveryReporter {
  constructor() {
    super(0);
  }

  override activate(): void {
    // Deliberately empty: nothing to report, so nothing can arm.
  }
}
