import { moduleStartedAt } from '@/lib/bundling-probe/clock';
import { probeHandler } from '@/lib/bundling-probe/handler';
import { start } from 'workflow/api';
import { heavyProbeWorkflow } from '@/workflows/bundling_probe_heavy';

// Bundling probe: starts a workflow whose steps import heavy SDKs.
const moduleEvaluatedAt = Date.now();
void moduleStartedAt;
export const POST = probeHandler({
  name: 'heavy',
  moduleEvaluatedAt,
  start: (at) => start(heavyProbeWorkflow, [at]),
});
