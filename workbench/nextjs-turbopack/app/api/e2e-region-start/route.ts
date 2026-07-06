import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { regionProbeWorkflow } from '@/workflows/99_e2e';

const KNOWN_REGIONS = new Set(['iad1', 'sfo1', 'fra1']);

/**
 * Starts `regionProbeWorkflow` with an explicit `region` option from
 * INSIDE the deployment, so the initial queue publish takes the same
 * path production workflow traffic does (direct, in-function, regional
 * queue routing) rather than the external token/proxy path the e2e test
 * process would use — the proxy path does not (yet) route queue sends
 * by region. Used by packages/core/e2e/e2e-region.test.ts.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as { region?: string; label?: string };
  const { region, label } = body;
  if (!region || !KNOWN_REGIONS.has(region)) {
    return NextResponse.json(
      { error: `"region" must be one of: ${[...KNOWN_REGIONS].join(', ')}` },
      { status: 400 }
    );
  }

  const run = await start(regionProbeWorkflow, [label ?? `probe-${region}`], {
    region,
  });

  return NextResponse.json({
    runId: run.runId,
    startedInRegion: process.env.VERCEL_REGION ?? null,
  });
}
