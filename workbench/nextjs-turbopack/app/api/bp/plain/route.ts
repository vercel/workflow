import { moduleStartedAt } from '@/lib/bundling-probe/clock';
import { probeHandler } from '@/lib/bundling-probe/handler';

// Bundling probe control: imports nothing from the Workflow SDK.
const moduleEvaluatedAt = Date.now();
void moduleStartedAt;
export const POST = probeHandler({ name: 'plain', moduleEvaluatedAt });
