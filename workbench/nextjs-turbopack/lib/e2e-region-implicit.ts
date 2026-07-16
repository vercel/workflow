import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { regionProbeWorkflow } from '@/workflows/99_e2e';

/**
 * Shared handler for the per-region implicit-start e2e routes
 * (`/api/e2e-region-implicit/{iad1,sfo1,fra1}`).
 *
 * Each route is pinned to a single region via a per-function `regions`
 * entry in this workbench's vercel.json, and calls `start()` WITHOUT an
 * explicit `region` option — exercising the implicit path where
 * `@workflow/world-vercel`'s `createRunId` derives the region from the
 * `VERCEL_REGION` env var of the function minting the run. The e2e suite
 * asserts the minted run ID carries the route's region tag and that the
 * run executes there.
 */
export async function startImplicitRegionProbe(
  request: Request
): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as {
    label?: string;
  };
  const region = process.env.VERCEL_REGION ?? null;
  const run = await start(regionProbeWorkflow, [
    body.label ?? `implicit-${region}`,
  ]);
  return NextResponse.json({
    runId: run.runId,
    startedInRegion: region,
  });
}
