import type { JSX, ReactNode } from 'react';
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
    title: 'Deep integration with AI SDK',
    description:
      'Use familiar AI SDK patterns, plus durability, observability, and retries so agents stay reliable in production.',
    visual: <AiSdkVisual />,
  },
  {
    title: 'Durable agents by default',
    description:
      'High-performance streaming, persistence, and resumable runs work out of the box. No infrastructure setup required.',
    visual: <AgentsVisual />,
  },
  {
    title: 'Inspect every run end\u2011to\u2011end',
    description:
      'Observability is built into the SDK and works anywhere you run it. When using workflow on Vercel, observability is built into the Vercel dashboard with no configuration or storage.',
    visual: <O11yVisual />,
  },
];

function FeatureCard({ title, description, visual }: Feature): JSX.Element {
  return (
    <div className="flex flex-col items-stretch justify-between gap-6 md:gap-10 py-8 sm:py-12">
      <div className="flex flex-col gap-2">
        <h3 className="text-heading-20 sm:text-heading-24 lg:text-heading-32">
          {title}
        </h3>
        <p className="text-lg text-muted-foreground sm:max-w-lg">
          {description}
        </p>
      </div>
      <div className="@container flex items-center justify-center overflow-hidden">
        {visual}
      </div>
    </div>
  );
}

function FeatureCardWide({ title, description, visual }: Feature): JSX.Element {
  return (
    <div className="flex flex-col items-start sm:items-center gap-8 md:gap-12">
      <div className="flex flex-col items-start sm:items-center max-w-[800px] text-left sm:text-center sm:mx-auto">
        <h3 className="text-heading-20 sm:text-heading-24 md:text-heading-32 lg:text-heading-40">
          {title}
        </h3>
        <p className="text-lg text-muted-foreground mt-4 sm:text-balance">
          {description}
        </p>
      </div>
      <div className="@container w-full max-w-[1200px] px-px overflow-hidden">
        {visual}
      </div>
    </div>
  );
}

export function FeatureGrid(): JSX.Element {
  return (
    <div className="grid lg:grid-cols-2">
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
      <div className="grid lg:grid-cols-2 gap-6 md:gap-24">
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
