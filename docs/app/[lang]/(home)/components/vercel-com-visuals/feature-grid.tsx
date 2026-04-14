import type { JSX, ReactNode } from 'react';

import { AgentsVisual } from './agents-visual';
import { AiSdkVisual } from './ai-sdk-visual';
import { DowntimeVisual } from './downtime-visual';
import { InfraVisual } from './infra-visual';
import { O11yVisual } from './o11y-visual';
import { TimeoutVisual } from './timeout-visual';
import { UsageVisual } from './usage-visual';

interface Feature {
  title: string;
  description: string;
  visual: ReactNode;
}

const features: Feature[] = [
  {
    title: 'Deep integration with AI SDK.',
    description:
      'Use familiar AI SDK patterns, plus durability, observability, and retries so agents stay reliable in production.',
    visual: <AiSdkVisual />,
  },
  {
    title: 'Durable agents by default.',
    description:
      'High-performance streaming, persistence, and resumable runs work out of the box. No infrastructure setup required.',
    visual: <AgentsVisual />,
  },
  {
    title: 'Inspect every run end\u2011to\u2011end.',
    description:
      'When deploying workflow on Vercel, deep workflow observability is built into the Vercel dashboard with no configuration or storage.',
    visual: <O11yVisual />,
  },
  {
    title: 'Zero infrastructure management.',
    description:
      'Fluid compute, serverless functions, queues and persistence work out of the box.',
    visual: <InfraVisual />,
  },
  {
    title: 'Deploy confidently.',
    description:
      'Running workflows continue on their original version while new executions use the latest code.',
    visual: <DowntimeVisual />,
  },
  {
    title: 'No timeout limits.',
    description:
      'Write long-running workflows without worrying about execution limits.',
    visual: <TimeoutVisual />,
  },
  {
    title: 'Pay for what you use.',
    description: 'Only pay for actual execution time, not idle resources.',
    visual: <UsageVisual />,
  },
];

function FeatureCard({ title, description, visual }: Feature): JSX.Element {
  return (
    <div className="flex flex-col items-stretch justify-between gap-6 md:gap-10 px-4 py-8 sm:py-12 sm:px-12">
      <p className="text-[20px] leading-[26px] tracking-[-0.4px] font-medium text-gray-900 lg:text-[24px] lg:leading-[32px] lg:tracking-[-0.96px]">
        <strong className="font-semibold text-gray-1000">{title}</strong>{' '}
        {description}
      </p>
      <div className="@container flex items-center justify-center overflow-hidden">
        {visual}
      </div>
    </div>
  );
}

function FeatureCardWide({ title, description, visual }: Feature): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-8 md:gap-12 px-4 py-8 sm:py-12 sm:px-12">
      <div className="flex flex-col items-center gap-4 max-w-[640px] text-center">
        <h3 className="text-[24px] leading-[32px] tracking-[-0.96px] font-semibold text-gray-1000 md:text-[32px] md:leading-[40px] md:tracking-[-1.28px]">
          {title}
        </h3>
        <p className="text-[16px] leading-[24px] tracking-normal text-gray-900 md:text-[18px] md:leading-[28px]">
          {description}
        </p>
      </div>
      <div className="@container w-full overflow-hidden">{visual}</div>
    </div>
  );
}

export function FeatureGrid(): JSX.Element {
  return (
    <div className="grid lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x">
      {features.slice(0, 2).map((feature) => (
        <FeatureCard key={feature.title} {...feature} />
      ))}
    </div>
  );
}

export function FeatureGridExtended(): JSX.Element {
  return (
    <>
      {/* AI SDK + Agents — 2 col */}
      <div className="grid lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x">
        {features.slice(0, 2).map((feature) => (
          <FeatureCard key={feature.title} {...feature} />
        ))}
      </div>
      {/* Observability — full width */}
      <div>
        <FeatureCardWide {...features[2]} />
      </div>
      {/* Infra + Deploy — 2 col */}
      <div className="grid lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x">
        {features.slice(3, 5).map((feature) => (
          <FeatureCard key={feature.title} {...feature} />
        ))}
      </div>
      {/* Timeout + Usage — 2 col */}
      <div className="grid lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x">
        {features.slice(5, 7).map((feature) => (
          <FeatureCard key={feature.title} {...feature} />
        ))}
      </div>
    </>
  );
}
