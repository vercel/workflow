import { moduleStartedAt } from '@/lib/bundling-probe/clock';
import { probeHandler } from '@/lib/bundling-probe/handler';
import { start } from 'workflow/api';
import { lightProbeWorkflow } from '@/workflows/bundling_probe';

// Bundling probe: the light probe, plus loading its inline entry when
// the module is evaluated (kicked off, not awaited) rather than on the first
// `start()`. Reports when that load finished.
const moduleEvaluatedAt = Date.now();
void moduleStartedAt;
let entryLoadedAt: number | undefined;
let entryLoadError: string | undefined;
const entryLoadStartedAt = Date.now();
// The per-workflow inline entry `withWorkflow()`'s loader registered for
// this workflow (see `@workflow/core`'s `INLINE_WORKFLOW_LOADERS_KEY`).
const loaders = (globalThis as Record<symbol, unknown>)[
  Symbol.for('@workflow/core//inlineWorkflowLoaders')
] as Map<string, () => Promise<unknown>> | undefined;
const loader = loaders?.get(
  (lightProbeWorkflow as unknown as { workflowId: string }).workflowId
);
(loader ? loader() : Promise.reject(new Error('no inline entry'))).then(
  () => {
    entryLoadedAt = Date.now();
  },
  (e: unknown) => {
    entryLoadError = String(e);
  }
);
export const POST = probeHandler({
  name: 'eager',
  moduleEvaluatedAt,
  start: (at) => start(lightProbeWorkflow, [at]),
  extra: () => ({
    entryLoadMs:
      entryLoadedAt === undefined ? null : entryLoadedAt - entryLoadStartedAt,
    entryLoadError: entryLoadError ?? null,
  }),
});
