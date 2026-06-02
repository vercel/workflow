import { createMdxComponents } from '@vercel/geistdocs/mdx';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import type { MDXComponents } from 'mdx/types';
import { AgentTraces } from '@/components/custom/agent-traces';
import { FluidComputeCallout } from '@/components/custom/fluid-compute-callout';
import { PreviewInstallServer } from '@/components/preview-install-server';
import * as AccordionComponents from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { TSDoc } from '@/lib/tsdoc';

const WorldTestingPerformance = () => null;

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
