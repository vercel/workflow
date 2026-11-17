import { moduleStartedAt } from '@/lib/bundling-probe/clock';
import { probeHandler } from '@/lib/bundling-probe/handler';
import { start } from 'workflow/api';
import { lightProbeWorkflow } from '@/workflows/bundling_probe';

// Bundling probe: the light probe, plus loading the inline flow entry when
// the module is evaluated (kicked off, not awaited) rather than on the first
// `start()`. Reports when that load finished.
const moduleEvaluatedAt = Date.now();
void moduleStartedAt;
let entryLoadedAt: number | undefined;
let entryLoadError: string | undefined;
const entryLoadStartedAt = Date.now();
// @ts-ignore: aliased by `withWorkflow()`; no types.
import('@workflow/core/inline-entry').then(
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
