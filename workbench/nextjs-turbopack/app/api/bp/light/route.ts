import { moduleStartedAt } from '@/lib/bundling-probe/clock';
import { probeHandler } from '@/lib/bundling-probe/handler';
import { start } from 'workflow/api';
import { lightProbeWorkflow } from '@/workflows/bundling_probe';

// Bundling probe: starts a workflow with two trivial steps.
const moduleEvaluatedAt = Date.now();
void moduleStartedAt;
export const POST = probeHandler({
  name: 'light',
  moduleEvaluatedAt,
  start: (at) => start(lightProbeWorkflow, [at]),
});
