import { startImplicitRegionProbe } from '@/lib/e2e-region-implicit';

// Pinned to icn1 via vercel.json ("functions" entry for this route);
// start() here relies on implicit VERCEL_REGION-derived region tagging.
export async function POST(request: Request) {
  return startImplicitRegionProbe(request);
}
