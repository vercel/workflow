import { NextResponse } from 'next/server';
import { getRun, resumeHook, start } from 'workflow/api';
import { crossRegionRedisRelayWorkflow } from '@/workflows/99_e2e';

const CHUNK_ZERO = 'owner-chunk';
const CHUNK_ONE = 'relayed-chunk';

/** Start an iad1 run and establish its default stream with the first write. */
export async function startCrossRegionStreamWrite(): Promise<NextResponse> {
  const region = process.env.VERCEL_REGION ?? null;
  const token = `cross-region-stream-${crypto.randomUUID()}`;
  const run = await start(crossRegionRedisRelayWorkflow, [token]);
  const ops: Promise<unknown>[] = [];
  const writer = run.getWritable<string>({ ops }).getWriter();
  await writer.write(CHUNK_ZERO);
  writer.releaseLock();
  await Promise.all(ops);
  return NextResponse.json({ runId: run.runId, token, region });
}

/** Contribute from sfo1, close the shared stream, then release the parked run. */
export async function finishCrossRegionStreamWrite(
  request: Request
): Promise<NextResponse> {
  const { runId, token } = (await request.json()) as {
    runId?: string;
    token?: string;
  };
  if (!runId || !token) {
    return NextResponse.json(
      { error: '"runId" and "token" are required' },
      { status: 400 }
    );
  }
  const run = getRun(runId);
  const ops: Promise<unknown>[] = [];
  const writer = run.getWritable<string>({ ops }).getWriter();
  await writer.write(CHUNK_ONE);
  await writer.close();
  await Promise.all(ops);
  // The workflow registers its hook asynchronously after start() returns. The
  // stream writes usually outlast that setup, but retry briefly so this probe
  // does not turn scheduling variance into a false routing failure.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await resumeHook(token, { done: true });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return NextResponse.json({ region: process.env.VERCEL_REGION ?? null });
}
