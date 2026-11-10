import { start } from 'workflow/api';
import {
  inlineTimingWorkflow,
  processInstanceId,
} from '@/workflows/inline_start';

/**
 * The same start as ../inline-start without the flow entry import: the
 * bundle-size and cold-start baseline. `experimental_inline` here has no
 * handler to run with, so the run is always queued.
 */
export async function POST() {
  const startCalledAt = Date.now();
  const run = await start(inlineTimingWorkflow, [startCalledAt]);
  return Response.json({
    runId: run.runId,
    inline: false,
    startCalledAt,
    startReturnedAt: Date.now(),
    instance: processInstanceId(),
    region: process.env.VERCEL_REGION ?? null,
  });
}
