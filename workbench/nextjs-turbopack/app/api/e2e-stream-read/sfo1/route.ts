import { NextResponse } from 'next/server';
import { getRun } from 'workflow/api';

export const dynamic = 'force-dynamic';

/**
 * Cross-region stream reader for the multi-region e2e suite.
 *
 * Pinned to sfo1 via this workbench's vercel.json so the read executes in
 * a DIFFERENT region than the stream's writer (the e2e starts the
 * streaming workflow in iad1). No write for the stream was served from
 * this region, so chunk visibility here depends entirely on the
 * backend's cross-region stream metadata — which must be correct while
 * the stream is still in progress.
 *
 * Returns the stream's tail index (highest known chunk index; -1 when no
 * chunks are visible) plus the region this read executed in.
 */
export async function POST(request: Request) {
  const { runId } = (await request.json()) as { runId?: string };
  if (!runId) {
    return NextResponse.json({ error: '"runId" is required' }, { status: 400 });
  }

  const run = getRun(runId);
  const readable = run.getReadable();
  const tailIndex = await readable.getTailIndex();

  return NextResponse.json({
    tailIndex,
    readRegion: process.env.VERCEL_REGION ?? null,
  });
}
