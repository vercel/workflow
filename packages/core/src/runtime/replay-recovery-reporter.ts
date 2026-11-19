import type { CreateEventParams } from '@workflow/world';

/**
 * The most divergent event ids a write reports, newest kept. The recovery
 * budget is env-tunable without a clamp, so the list a delivery keeps is not
 * bounded by itself.
 */
export const MAX_REPORTED_DIVERGENCE_EVENT_IDS = 8;

/**
 * The divergent event ids a write reports (`replayDivergenceEventIds`): the
 * newest {@link MAX_REPORTED_DIVERGENCE_EVENT_IDS} of them, or none.
 */
export function reportedDivergenceEventIds(
  eventIds: readonly string[] | undefined
): Pick<CreateEventParams, 'replayDivergenceEventIds'> {
  if (!eventIds || eventIds.length === 0) return {};
  return {
    replayDivergenceEventIds: eventIds.slice(
      -MAX_REPORTED_DIVERGENCE_EVENT_IDS
    ),
  };
}

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

  constructor(
    private readonly divergenceCount: number,
    /** The event each divergence of the episode was found at, oldest first. */
    private readonly divergenceEventIds: readonly string[] = []
  ) {}

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
      return await create({
        ...params,
        replayDivergenceCount: this.divergenceCount,
        ...reportedDivergenceEventIds(this.divergenceEventIds),
      });
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
