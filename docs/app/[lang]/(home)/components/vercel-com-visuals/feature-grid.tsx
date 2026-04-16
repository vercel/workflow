import Link from 'next/link';
import type { JSX, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { AgentsVisual } from './agents-visual';
import { AiSdkVisual } from './ai-sdk-visual';
import { O11yVisual } from './o11y-visual';

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
      'Observability is built into the SDK and works anywhere you run it. When using workflow on Vercel, observability is built into the Vercel dashboard with no configuration or storage.',
    visual: <O11yVisual />,
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
      <div className="flex flex-col items-center max-w-[800px] text-center mx-auto">
        <h3 className="font-semibold text-xl tracking-tight sm:text-2xl md:text-3xl lg:text-[40px]">
          {title}
        </h3>
        <p className="text-balance text-lg text-muted-foreground mt-4">
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
    </>
  );
}
