import { Callout } from '@vercel/geistdocs/components/callout';
import { createMdxComponents } from '@vercel/geistdocs/mdx';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import type { MDXComponents } from 'mdx/types';
import { AgentTraces } from '@/components/custom/agent-traces';
import { FluidComputeCallout } from '@/components/custom/fluid-compute-callout';
import { PreviewInstallServer } from '@/components/preview-install-server';
import * as AccordionComponents from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
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
    TSDoc,
    Step,
    Steps,
    ...AccordionComponents,
    Tabs,
    Tab,
    PreviewInstall: PreviewInstallServer,
    WorldTestingPerformance,
    ...components,
  });
