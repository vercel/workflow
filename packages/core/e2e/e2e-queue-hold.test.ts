import {
  type HeldQueueMessage,
  type QueueHoldResult,
  SPEC_VERSION_LEGACY,
  type ValidQueueName,
  type World,
} from '@workflow/world';
import { beforeAll, describe, expect, test } from 'vitest';
import { getWorld } from '../src/runtime';
import { setupWorld } from './utils';

/**
 * Vercel-specific suite for send-and-hold (`QueueOptions.experimental_hold`)
 * against the real queue service.
 *
 * Each test sends a queue health check (`__healthCheck`), the one message the
 * deployment's flow route answers without a run: it writes a response to the
 * stream named after the probe's correlation ID. That gives every outcome an
 * observable side:
 *
 * - held and consumed here: this process runs the message, so the flow route
 *   never answers, not even after the hold's lease would have lapsed;
 * - held and never consumed: the queue delivers it when the lease lapses, and
 *   the flow route answers then;
 * - held and released: the flow route answers at once;
 * - not held: the queue delivers it as usual, and the flow route answers.
 *
 * The queue service decides whether a send is held. Until send-and-hold is on
 * for the target, every send comes back `not_held` and only the fallback is
 * proven, so each test asserts the fallback then. Set
 * `WORKFLOW_E2E_EXPECT_QUEUE_HOLD=1` (the `e2e-vercel-queue-hold` job reads it
 * from a repository variable) to make `not_held` a failure once it is on.
 *
 * Runs as its own CI job (e2e-vercel-queue-hold in tests.yml) against
 * nextjs-turbopack only: a hold is a World and queue feature, the same for
 * every framework.
 */

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

const expectHeld = process.env.WORKFLOW_E2E_EXPECT_QUEUE_HOLD === '1';

/** The hold's lease. Vercel Queues' minimum, so the lapse tests stay short. */
const LEASE_SECONDS = 30;

const HEALTH_CHECK_QUEUE = '__wkf_workflow_health_check' as ValidQueueName;

// Mirrors `getHealthCheckStreamName` / `generateHealthCheckRunId` in
// src/runtime/helpers.ts, which the flow route writes its answer under.
const answerStream = (correlationId: string) => ({
  runId: `wrun_hc_${correlationId}`,
  name: `__health_check__${correlationId}`,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends a health check with a hold, under a fresh correlation ID. */
async function sendHeldHealthCheck(world: World) {
  // Region-tagged where the World tags IDs, so the probe's stream resolves to
  // the same backend on both sides (see `healthCheck`).
  const correlationId =
    world.createRunId?.() ??
    `hold_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const sent = await world.queue(
    HEALTH_CHECK_QUEUE,
    { __healthCheck: true, correlationId },
    {
      // The JSON transport, as `healthCheck` sends.
      specVersion: SPEC_VERSION_LEGACY,
      idempotencyKey: `e2e-queue-hold-${correlationId}`,
      experimental_hold: { visibilityTimeoutSeconds: LEASE_SECONDS },
    }
  );
  return { correlationId, sent };
}

/**
 * The flow route's answer to the probe, or `undefined` if it has not
 * answered within `withinMs`.
 */
async function flowAnswer(
  world: World,
  correlationId: string,
  withinMs: number
): Promise<Record<string, unknown> | undefined> {
  const { runId, name } = answerStream(correlationId);
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try {
      const stream = await world.streams.get(runId, name);
      const reader = stream.getReader();
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        sleep(Math.min(remaining, 5_000)).then(() => undefined),
      ]);
      void reader.cancel().catch(() => {});
      if (chunk && !chunk.done && chunk.value !== undefined) {
        const text =
          typeof chunk.value === 'string'
            ? chunk.value
            : new TextDecoder().decode(chunk.value as Uint8Array);
        return JSON.parse(text) as Record<string, unknown>;
      }
    } catch {
      // No stream yet.
    }
    await sleep(1_000);
  }
  return undefined;
}

/**
 * The held message, or `undefined` when the send was not held. A `not_held`
 * answer is a failure in strict mode; otherwise the caller asserts the
 * fallback instead.
 */
function heldOrFallback(
  hold: QueueHoldResult | undefined
): HeldQueueMessage | undefined {
  if (hold?.status === 'held') return hold;
  if (expectHeld) {
    throw new Error(
      `expected the send to be held, got ${JSON.stringify(hold ?? 'no experimental_hold')}`
    );
  }
  // Not a failure while send-and-hold is off for this target: the queue
  // delivers the message instead, which the caller checks.
  console.info(
    `[e2e-queue-hold] send not held (${hold ? hold.reason : 'no experimental_hold'}); asserting the queue delivers it instead`
  );
  return undefined;
}

describe
  .skipIf(!process.env.WORKFLOW_VERCEL_ENV)
  .concurrent('send-and-hold (experimental_hold)', () => {
    let world: World;

    beforeAll(async () => {
      setupWorld(deploymentUrl);
      world = await getWorld();
      // world-vercel declares it; this suite runs only against Vercel.
      expect(world.capabilities?.experimental_queueHold).toBe(true);
    });

    test(
      'a held message runs in the process that sent it and is not delivered again',
      { timeout: 180_000 },
      async () => {
        const { correlationId, sent } = await sendHeldHealthCheck(world);
        const held = heldOrFallback(sent.experimental_hold);
        if (!held) {
          expect(await flowAnswer(world, correlationId, 60_000)).toMatchObject({
            healthy: true,
            correlationId,
          });
          return;
        }

        expect(held.messageId).toBe(sent.messageId);
        const runs: { message: unknown; meta: Record<string, unknown> }[] = [];
        await held.consume(async (message, meta) => {
          runs.push({ message, meta });
        });
        expect(runs).toHaveLength(1);
        expect(runs[0]?.message).toMatchObject({
          __healthCheck: true,
          correlationId,
        });
        expect(runs[0]?.meta).toMatchObject({
          messageId: held.messageId,
          deliveryCount: 1,
          attempt: 1,
          queueName: HEALTH_CHECK_QUEUE,
        });

        // Acknowledged: past the point where a lapsed lease would have been
        // delivered, the flow route still has not seen it.
        expect(
          await flowAnswer(world, correlationId, (LEASE_SECONDS + 30) * 1_000)
        ).toBeUndefined();
      }
    );

    test(
      'a held message that is never consumed is delivered once its lease lapses',
      { timeout: 240_000 },
      async () => {
        const { correlationId, sent } = await sendHeldHealthCheck(world);
        const held = heldOrFallback(sent.experimental_hold);
        if (!held) {
          expect(await flowAnswer(world, correlationId, 60_000)).toMatchObject({
            healthy: true,
          });
          return;
        }

        // Nothing renews the hold (the sender "crashed"). Well inside the
        // lease, the queue does not deliver it.
        expect(
          await flowAnswer(world, correlationId, (LEASE_SECONDS / 2) * 1_000)
        ).toBeUndefined();
        // Once the lease lapses, it does.
        expect(
          await flowAnswer(world, correlationId, (LEASE_SECONDS + 120) * 1_000)
        ).toMatchObject({ healthy: true, correlationId });
      }
    );

    test(
      'a released held message is delivered at once',
      { timeout: 120_000 },
      async () => {
        const { correlationId, sent } = await sendHeldHealthCheck(world);
        const held = heldOrFallback(sent.experimental_hold);
        if (held) await held.release();
        // Released (or never held): delivered without waiting out a lease.
        expect(
          await flowAnswer(world, correlationId, (LEASE_SECONDS - 5) * 1_000)
        ).toMatchObject({ healthy: true, correlationId });
      }
    );
  });
