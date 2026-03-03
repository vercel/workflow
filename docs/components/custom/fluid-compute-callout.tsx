import { Callout } from '@/components/geistdocs/callout';

export const FluidComputeCallout = () => (
  <Callout type="warn">
    <strong>Enable Fluid compute before deploying.</strong> Workflow is designed
    to take advantage of{' '}
    <a href="https://vercel.com/docs/functions/fluid-compute">Fluid compute</a>{' '}
    for efficient suspension and resumption. Without Fluid compute enabled, each
    workflow resume incurs a separate function cold start, which can result in
    significantly higher costs.
  </Callout>
);
