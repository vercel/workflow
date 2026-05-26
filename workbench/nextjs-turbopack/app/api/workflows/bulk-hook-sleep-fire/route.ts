import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resumeHook, start } from 'workflow/api';
import { hookSleepReproWorkflow } from '@/workflows/101_hook_sleep_repro';

export const maxDuration = 300;

interface BulkBody {
  count?: number;
  iterations?: number;
  sleepMs?: number;
  returnOnWake?: boolean;
  finalDelayMs?: number;
  drainDelayMs?: number;
  sleepBranchWaitCount?: number;
  sleepBranchWaitMs?: number;
  sleepBranchWaitSpacingMs?: number;
  // Fire the hook N ms after start. If <= 0 or omitted, no fire.
  fireAfterMs?: number;
  // Number of payloads to fire per workflow (after fireAfterMs delay).
  fireCount?: number;
  // Delay between consecutive fires for the same token.
  fireBurstSpacingMs?: number;
  // Retry the resumeHook on transient "Hook not found" so workflows that
  // haven't yet reached createHook by fireAfterMs still get their hook.
  fireRetries?: number;
  fireRetryDelayMs?: number;
}

export async function POST(request: NextRequest) {
  let body: BulkBody = {};
  try {
    body = (await request.json()) as BulkBody;
  } catch {}

  const count = body.count ?? 500;
  const fireAfterMs = body.fireAfterMs ?? 1500;
  const fireCount = body.fireCount ?? 2;
  const fireRetries = body.fireRetries ?? 0;
  const fireRetryDelayMs = body.fireRetryDelayMs ?? 250;

  const batchId = randomUUID();
  const startedAt = Date.now();

  console.log(
    `[bulk-hook-sleep-fire] batch=${batchId} starting count=${count} iterations=${body.iterations ?? 2} sleepMs=${body.sleepMs ?? 5000} fireAfterMs=${fireAfterMs} fireCount=${fireCount}`
  );

  const started = await Promise.allSettled(
    Array.from({ length: count }).map(async (_, index) => {
      const token = `fire-${batchId}-${index}`;
      const input = {
        token,
        iterations: body.iterations,
        sleepMs: body.sleepMs,
        returnOnWake: body.returnOnWake,
        finalDelayMs: body.finalDelayMs,
        drainDelayMs: body.drainDelayMs,
        sleepBranchWaitCount: body.sleepBranchWaitCount,
        sleepBranchWaitMs: body.sleepBranchWaitMs,
        sleepBranchWaitSpacingMs: body.sleepBranchWaitSpacingMs,
      };
      const run = await start(hookSleepReproWorkflow, [input]);
      return { runId: run.runId, token };
    })
  );

  const succeeded = started.filter((r) => r.status === 'fulfilled');
  const tokens = succeeded.map(
    (r) => (r as PromiseFulfilledResult<{ token: string }>).value.token
  );

  console.log(
    `[bulk-hook-sleep-fire] batch=${batchId} started=${succeeded.length} failed=${started.length - succeeded.length} - waiting ${fireAfterMs}ms before firing hooks`
  );

  // Wait so workflows actually reach the sleep + hook-await state
  if (fireAfterMs > 0) {
    await new Promise((r) => setTimeout(r, fireAfterMs));
  }

  // Fire hooks for each workflow. Fire all per-token payloads in rapid
  // sequence (back-to-back) to maximize the chance that multiple
  // hook_received events queue up before the workflow consumes them.
  const fireBurstSpacingMs = body.fireBurstSpacingMs ?? 0;
  const fired = await Promise.allSettled(
    tokens.map(async (token) => {
      for (let i = 0; i < fireCount; i++) {
        const payload = { value: i, ts: Date.now() };
        let attempts = 0;
        // Retry transient "Hook not found" so a small fireAfterMs doesn't
        // mask the actual race we want to exercise.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            await resumeHook(token, payload);
            break;
          } catch (err) {
            attempts += 1;
            const msg = err instanceof Error ? err.message : String(err);
            const retryable =
              /not found/i.test(msg) || /fence conflict/i.test(msg);
            if (attempts > fireRetries || !retryable) {
              throw err;
            }
            await new Promise((r) => setTimeout(r, fireRetryDelayMs));
          }
        }
        if (fireBurstSpacingMs > 0) {
          await new Promise((r) => setTimeout(r, fireBurstSpacingMs));
        }
      }
      return token;
    })
  );

  const fireSucceeded = fired.filter((r) => r.status === 'fulfilled').length;
  const fireFailed = fired.length - fireSucceeded;
  void fireCount; // Each "token" entry above fires fireCount payloads in series.

  console.log(
    `[bulk-hook-sleep-fire] batch=${batchId} fired=${fireSucceeded} fireFailed=${fireFailed} totalElapsed=${Date.now() - startedAt}ms`
  );

  return NextResponse.json({
    batchId,
    count,
    started: succeeded.length,
    fired: fireSucceeded,
    fireFailed,
    durationMs: Date.now() - startedAt,
    runs: succeeded.map(
      (r) =>
        (r as PromiseFulfilledResult<{ runId: string; token: string }>).value
    ),
    sampleErrors: fired
      .filter((r) => r.status === 'rejected')
      .slice(0, 5)
      .map((r) =>
        r.status === 'rejected'
          ? r.reason instanceof Error
            ? r.reason.message
            : String(r.reason)
          : null
      ),
  });
}
