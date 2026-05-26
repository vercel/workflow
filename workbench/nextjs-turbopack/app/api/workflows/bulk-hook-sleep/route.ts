import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { hookSleepReproWorkflow } from '@/workflows/101_hook_sleep_repro';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let count = 500;
  let iterations: number | undefined;
  let sleepMs: number | undefined;
  let returnOnWake: boolean | undefined;
  let finalDelayMs: number | undefined;
  let drainDelayMs: number | undefined;
  let sleepBranchWaitCount: number | undefined;
  let sleepBranchWaitMs: number | undefined;
  let sleepBranchWaitSpacingMs: number | undefined;

  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.count === 'number') count = body.count;
    if (typeof body.iterations === 'number') iterations = body.iterations;
    if (typeof body.sleepMs === 'number') sleepMs = body.sleepMs;
    if (typeof body.returnOnWake === 'boolean')
      returnOnWake = body.returnOnWake;
    if (typeof body.finalDelayMs === 'number') finalDelayMs = body.finalDelayMs;
    if (typeof body.drainDelayMs === 'number') drainDelayMs = body.drainDelayMs;
    if (typeof body.sleepBranchWaitCount === 'number')
      sleepBranchWaitCount = body.sleepBranchWaitCount;
    if (typeof body.sleepBranchWaitMs === 'number')
      sleepBranchWaitMs = body.sleepBranchWaitMs;
    if (typeof body.sleepBranchWaitSpacingMs === 'number')
      sleepBranchWaitSpacingMs = body.sleepBranchWaitSpacingMs;
  } catch {
    // empty body ok
  }

  const batchId = randomUUID();
  const startedAt = Date.now();

  console.log(
    `[bulk-hook-sleep] batch=${batchId} starting count=${count} iterations=${iterations ?? 2} sleepMs=${sleepMs ?? 5000}`
  );

  const results = await Promise.allSettled(
    Array.from({ length: count }).map(async (_, index) => {
      const token = `bulk-${batchId}-${index}`;
      const input = {
        token,
        iterations,
        sleepMs,
        returnOnWake,
        finalDelayMs,
        drainDelayMs,
        sleepBranchWaitCount,
        sleepBranchWaitMs,
        sleepBranchWaitSpacingMs,
      };
      const run = await start(hookSleepReproWorkflow, [input]);
      return { runId: run.runId, token };
    })
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');

  console.log(
    `[bulk-hook-sleep] batch=${batchId} done in ${Date.now() - startedAt}ms succeeded=${succeeded.length} failed=${failed.length}`
  );

  return NextResponse.json({
    batchId,
    count,
    succeeded: succeeded.length,
    failed: failed.length,
    durationMs: Date.now() - startedAt,
    runs: succeeded.map((r) => (r as PromiseFulfilledResult<unknown>).value),
    errors: failed.map((r) =>
      r.status === 'rejected'
        ? r.reason instanceof Error
          ? r.reason.message
          : String(r.reason)
        : null
    ),
  });
}
