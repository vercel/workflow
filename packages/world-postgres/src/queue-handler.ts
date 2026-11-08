import {
  MessageId,
  type Queue,
  type QueuePrefix,
  readQueueDeliveryHeaders,
  singleOrchestratorRunIdOf,
  ValidQueueName,
} from '@workflow/world';
import { z } from 'zod/v4';

/**
 * Per-run mutual exclusion for orchestrator deliveries, in FIFO order.
 *
 * `acquire(runId)` resolves once every earlier holder for that run has
 * released, with the release function. Keys are dropped when the last holder
 * releases, so the map holds only runs with a delivery in flight or waiting.
 */
export function createRunGate() {
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(runId: string): Promise<() => void> {
      const previous = tails.get(runId) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => held);
      tails.set(runId, tail);
      await previous;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        if (tails.get(runId) === tail) tails.delete(runId);
      };
    },
    /** Runs with a delivery in flight or waiting. For tests. */
    size(): number {
      return tails.size;
    },
  };
}

export type RunGate = ReturnType<typeof createRunGate>;

/**
 * The delivery metadata a delivery request carries in its headers, under
 * the current names or the earlier release's (`readQueueDeliveryHeaders`):
 * a worker on the earlier release delivers over HTTP with the old names.
 */
const DeliveryHeaders = z.object({
  queueName: ValidQueueName,
  messageId: MessageId,
  attempt: z.coerce.number(),
  // `attempt` restarts on a reschedule; this keeps counting.
  deliveryCount: z.coerce.number().int().positive().optional(),
  // Absent on a delivery from a sender that predates it.
  createdAt: z.iso.datetime().optional(),
});

/**
 * The request handler behind `Queue.createQueueHandler` for the Postgres
 * World: parses a delivery's metadata and body, serializes one run's
 * orchestrator deliveries in this process through `runGate` (the queue half
 * of the single-writer guarantee, which Graphile's named queue provides
 * across processes), calls `handler`, and answers as the runtime expects: an
 * invoke message's result as `{ result }`, a `{ timeoutSeconds }` request as
 * is, anything else as `{ ok: true }`, and a thrown error as a 500 whose
 * body is the error's string form.
 */
export function createDeliveryHandler(
  prefix: QueuePrefix,
  handler: Parameters<Queue['createQueueHandler']>[1],
  options: {
    runGate: RunGate;
    /** Decodes a delivery body (the queue's transport). */
    deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown>;
  }
): (req: Request) => Promise<Response> {
  return async (req) => {
    const headers = DeliveryHeaders.safeParse(
      readQueueDeliveryHeaders(req.headers)
    );

    if (!headers.success || !req.body) {
      return Response.json(
        {
          error: !req.body
            ? 'Missing request body'
            : 'Missing required headers',
        },
        { status: 400 }
      );
    }

    const { queueName, messageId, attempt } = headers.data;
    const deliveryCountHeader = headers.data.deliveryCount;
    const createdAtHeader = headers.data.createdAt;

    if (!queueName.startsWith(prefix)) {
      return Response.json(
        {
          error: 'Unhandled queue',
          detail: `This route handles queue prefix "${prefix}", not "${queueName}".`,
        },
        { status: 400 }
      );
    }

    const body = await options.deserialize(req.body);
    const orchestratorRunId = singleOrchestratorRunIdOf(body);
    const releaseRun =
      orchestratorRunId === undefined
        ? undefined
        : await options.runGate.acquire(`${prefix}${orchestratorRunId}`);
    try {
      const result = await handler(body, {
        attempt,
        // Counts every delivery of this message that reached a handler,
        // starting at 1, including `{ timeoutSeconds }` redeliveries.
        deliveryCount: deliveryCountHeader ?? attempt,
        ...(createdAtHeader ? { createdAt: new Date(createdAtHeader) } : {}),
        queueName,
        messageId,
      });

      if (
        typeof body === 'object' &&
        body !== null &&
        'invoke' in body &&
        body.invoke === true
      ) {
        return Response.json({ result });
      }

      if (
        typeof result === 'object' &&
        result !== null &&
        'timeoutSeconds' in result &&
        typeof result.timeoutSeconds === 'number'
      ) {
        return Response.json({ timeoutSeconds: result.timeoutSeconds });
      }

      return Response.json({ ok: true });
    } catch (error) {
      return Response.json(String(error), { status: 500 });
    } finally {
      releaseRun?.();
    }
  };
}
