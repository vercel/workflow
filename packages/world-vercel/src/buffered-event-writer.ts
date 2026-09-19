import { WorkflowWorldError } from '@workflow/errors';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type EventResult,
  EventSchema,
  type EventWriteSession,
  getEventDataPayloadField,
  requireEventSlot,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  type Step,
  StepSchema,
  slotToEventId,
} from '@workflow/world';

type Write = (
  event: CreateEventRequest,
  params: CreateEventParams,
  onSent?: () => void
) => Promise<EventResult>;
type Pending = { expected: EventResult; completion: Promise<EventResult> };

/** Owner-private outbox. Standard reads and all materialization remain server-side. */
export class BufferedEventWriter implements EventWriteSession {
  private queued?: number;
  private committed?: number;
  private pending: Pending[] = [];
  private confirmed: EventResult[] = [];
  private queuedSteps = new Map<string, Step>();
  private bytes = 0;
  private failure?: unknown;
  private disposed = false;

  constructor(
    private runId: string,
    private write: Write,
    private release: () => Promise<void>,
    private flushThrough: (head: number) => Promise<void> = async () => {}
  ) {}

  get heads() {
    return { queued: this.queued, committed: this.committed };
  }

  private rememberStep(step: Step) {
    if (['completed', 'failed', 'cancelled'].includes(step.status))
      this.queuedSteps.delete(step.stepId);
    else this.queuedSteps.set(step.stepId, step);
  }

  private assertOpen(params?: CreateEventParams) {
    if (this.failure) throw this.failure;
    if (this.disposed) throw new Error('Event writer is disposed');
    const head = params?.eventCount;
    if (!Number.isSafeInteger(head) || head === undefined || head < 0)
      throw new Error('Buffered writer requires a canonical event count');
    this.queued ??= head;
    this.committed ??= head;
    if (head !== this.queued)
      throw new Error('Buffered writer sequence mismatch');
  }

  private fail(error: unknown) {
    this.failure ??= error;
    void this.release().catch(() => {});
    return error;
  }

  async create(
    event: CreateEventRequest,
    params: CreateEventParams = {}
  ): Promise<EventResult> {
    this.assertOpen(params);
    await this.drain();
    try {
      const result = await this.write(event, params);
      if (!result.event) throw new Error('Missing canonical event');
      this.queued = this.committed = requireEventSlot(result.event.eventId);
      if (result.step) this.rememberStep(result.step);
      return result;
    } catch (error) {
      throw this.fail(error);
    }
  }

  async stage(
    event: CreateEventRequest,
    params: CreateEventParams = {}
  ): Promise<EventResult> {
    this.assertOpen(params);
    const field = getEventDataPayloadField(event.eventType);
    const payload = field
      ? (event.eventData as Record<string, unknown> | undefined)?.[field]
      : undefined;
    const size = payload instanceof Uint8Array ? payload.byteLength : 0;
    const previous = event.correlationId
      ? this.queuedSteps.get(event.correlationId)
      : undefined;
    // Only deterministic, non-expanding transitions may advance the private VM
    // before ACK. Hook registration/conflict and other server-selected outcomes
    // first drain the prefix, then return their native result.
    const eligible =
      (event.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_SLOT_IDENTITY &&
      size <= 8 * 1024 * 1024 &&
      (event.eventType === 'hook_received' ||
        event.eventType === 'step_created' ||
        (event.eventType === 'step_started' &&
          previous?.status === 'pending') ||
        (event.eventType === 'step_completed' &&
          previous?.status === 'running'));
    if (!eligible) return this.create(event, params);
    if (this.pending.length >= 64 || this.bytes + size > 8 * 1024 * 1024)
      await this.drain();

    const occurredAt = params.occurredAt ?? new Date();
    const request = structuredClone(event);
    const expected: EventResult = {
      event: EventSchema.parse({
        ...request,
        runId: this.runId,
        eventId: slotToEventId(params.eventCount! + 1),
        createdAt: occurredAt,
        occurredAt,
        ...(params.resumeId ? { resumeId: params.resumeId } : {}),
      }),
    };
    if (event.eventType === 'step_created') {
      expected.step = StepSchema.parse({
        ...event.eventData,
        runId: this.runId,
        stepId: event.correlationId,
        status: 'pending',
        attempt: 0,
        createdAt: occurredAt,
        updatedAt: occurredAt,
        specVersion: event.specVersion,
      });
    } else if (event.eventType === 'step_started') {
      expected.step = StepSchema.parse({
        ...previous,
        status: 'running',
        attempt: previous!.attempt + 1,
        startedAt: occurredAt,
        updatedAt: occurredAt,
      });
    } else if (event.eventType === 'step_completed') {
      expected.step = StepSchema.parse({
        ...previous,
        status: 'completed',
        output: event.eventData?.result,
        completedAt: occurredAt,
        updatedAt: occurredAt,
      });
    }
    if (expected.step)
      this.queuedSteps.set(expected.step.stepId, expected.step);
    this.queued = params.eventCount! + 1;
    this.bytes += size;
    let sent!: () => void;
    let sendFailed!: (error: unknown) => void;
    const transmitted = new Promise<void>((resolve, reject) => {
      sent = resolve;
      sendFailed = reject;
    });
    const completion = this.write(
      request,
      { ...params, occurredAt },
      sent
    ).then(
      (result) => {
        sent(); // Receiving a response also proves transmission.
        const actual = result.event;
        if (
          !actual ||
          actual.eventId !== expected.event!.eventId ||
          actual.runId !== this.runId ||
          actual.eventType !== event.eventType ||
          +actual.createdAt !== +occurredAt
        )
          throw this.fail(
            new WorkflowWorldError(
              'Buffered canonical acknowledgement mismatch',
              { status: 409 }
            )
          );
        return result;
      },
      (error) => {
        sendFailed(error);
        throw this.fail(error);
      }
    );
    // Observe errors immediately; flush still receives the original rejection.
    void completion.catch(() => {});
    this.pending.push({ expected, completion });
    await transmitted;
    if (this.failure) throw this.failure;
    return expected;
  }

  private async drain() {
    if (this.failure) throw this.failure;
    const pending = this.pending;
    if (!pending.length) return;
    try {
      await this.flushThrough(this.queued!);
      const results = await Promise.all(pending.map((item) => item.completion));
      this.confirmed.push(...results);
      this.committed = requireEventSlot(
        results[results.length - 1].event!.eventId
      );
      this.pending = [];
      for (const result of results)
        if (result.step) this.rememberStep(result.step);
      this.bytes = 0;
    } catch (error) {
      throw this.fail(error);
    }
  }

  async flush(): Promise<readonly EventResult[]> {
    await this.drain();
    const results = this.confirmed;
    this.confirmed = [];
    return results;
  }

  async dispose() {
    this.disposed = true;
    await this.release();
  }
}
