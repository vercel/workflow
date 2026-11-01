import { Badge } from '@vercel/geistdocs/components/badge';
import { Callout } from '@vercel/geistdocs/components/callout';
import { createMdxComponents } from '@vercel/geistdocs/mdx';
import type { MDXComponents } from 'mdx/types';
import { AgentTraces } from '@/components/custom/agent-traces';
import { FluidComputeCallout } from '@/components/custom/fluid-compute-callout';
import { PerformanceExplainer } from '@/components/custom/performance/explainer';
import { MetricVideo } from '@/components/custom/performance/metric-video';
import { Details } from '@/components/geistdocs/details';
import { PreviewInstallServer } from '@/components/preview-install-server';
import { WorldTestingPerformance as WorldTestingPerformanceView } from '@/components/worlds/WorldTestingPerformance';
import { TSDoc } from '@/lib/tsdoc';
import { getWorldData } from '@/lib/worlds-data';

const isPreview = process.env.VERCEL_ENV === 'preview';

const WorldTestingPerformance = async ({
  worldId,
  showBenchmarks = isPreview,
}: {
  worldId?: string;
  showBenchmarks?: boolean;
}) => {
  if (!worldId) {
    return (
      <Callout type="warn">
        World testing data is unavailable because no world ID was provided.
      </Callout>
    );
  }

  const data = await getWorldData(worldId);
  if (!data) {
    return (
      <Callout type="warn">
        World testing data is unavailable for <code>{worldId}</code>.
      </Callout>
    );
  }

  return (
    <WorldTestingPerformanceView
      worldId={worldId}
      world={data.world}
      meta={data.meta}
      showBenchmarks={showBenchmarks}
    />
  );
};

export const getMDXComponents = (components?: MDXComponents): MDXComponents =>
  createMdxComponents({
    AgentTraces,
    FluidComputeCallout,
    Badge,
    Details,
    MetricVideo,
    PerformanceExplainer,
    TSDoc,
    PreviewInstall: PreviewInstallServer,
    WorldTestingPerformance,
    ...components,
  });
