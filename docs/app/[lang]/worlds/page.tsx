import type { Metadata } from 'next';
import Link from 'next/link';
import { PlainGlobe } from '@/app/[lang]/(home)/components/vercel-com-visuals';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WorldsFilteredGrid } from '@/components/worlds/WorldsFilteredGrid';
import { getWorldsData } from '@/lib/worlds-data';

export const metadata: Metadata = {
  title: 'Worlds | Workflow SDK',
  description:
    'The World abstraction allows workflows to run anywhere — locally, on Vercel, or on any cloud. The runtime, queues, and persistence are modular and entirely swappable.',
  openGraph: {
    images: ['/og/worlds'],
  },
};

export default async function WorldsPage() {
  const data = await getWorldsData();

  // Sort worlds: official first, then community, alphabetically within each group
  const sortedWorlds = Object.entries(data.worlds).sort(([, a], [, b]) => {
    if (a.type === 'official' && b.type !== 'official') return -1;
    if (a.type !== 'official' && b.type === 'official') return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter sm:mt-24">
      <div className="mx-auto w-full max-w-[1080px]">
        {/* Hero Section */}
        <section className="relative px-4 overflow-hidden text-center h-[340px]">
          {/* Globe backdrop */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-[85%] translate-y-[20%]">
              <PlainGlobe />
            </div>
          </div>

          {/* Content */}
          <div className="relative z-10 mt-32 sm:mt-28 mx-auto w-full max-w-3xl space-y-3 sm:space-y-5">
            <h1 className="text-center font-semibold text-4xl leading-[1.1] tracking-tight sm:text-5xl xl:text-6xl text-balance">
              Worlds
            </h1>
            <p className="text-balance text-muted-foreground sm:text-xl leading-relaxed">
              The World abstraction allows workflows to run anywhere — locally,
              on Vercel, or on any cloud. The runtime, queues, and persistence
              are modular and entirely swappable.
            </p>
          </div>
        </section>

        {/* Filters + World Cards */}
        <WorldsFilteredGrid worlds={sortedWorlds} />

        {/* Last Updated */}
        <div className="px-4 pb-8 text-center text-xs text-muted-foreground">
          Last updated: {new Date(data.lastUpdated).toLocaleString()}
          {data.commit && (
            <>
              {' · '}
              Commit:{' '}
              <a
                href={`https://github.com/vercel/workflow/commit/${data.commit}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono hover:underline"
              >
                {data.commit.slice(0, 7)}
              </a>
            </>
          )}
        </div>

        {/* Provider Benchmarks Section */}
        <section className="border-t px-4 py-12 sm:py-16">
          <div className="flex flex-col lg:flex-row gap-8 items-start justify-between">
            {/* Left: Text content */}
            <div className="space-y-4 mt-4 max-w-md">
              <div className="flex items-center gap-2.5">
                <h2 className="font-semibold text-2xl tracking-tight sm:text-3xl">
                  Provider Benchmarks
                </h2>
                <Badge variant="outline" className="text-sm">
                  Coming soon
                </Badge>
              </div>
              <p className="text-muted-foreground max-w-md">
                See how workflows compare across the different worlds deployed
                on different providers. Lower execution time means faster
                workflows.
              </p>
              {/* <Button variant="secondary" size="lg" className="mt-2" disabled>
                  Coming Soon
                </Button> */}
            </div>

            {/* Right: Benchmark preview visualization */}
            <div className="w-full lg:max-w-lg min-w-0 space-y-3">
              {/* Header row */}
              <div className="flex items-center gap-3 text-xs text-muted-foreground uppercase tracking-wider">
                <div className="w-16" />
                <div className="flex-1" />
                <div className="w-14 text-right text-gray-1000 font-medium font-mono">
                  Perf
                </div>
              </div>

              {/* Benchmark bars */}
              {[
                {
                  name: 'Local',
                  time: 10.76,
                  color: 'bg-green-700 dark:bg-green-600',
                },
                { name: 'Vercel', time: 19.37, color: 'bg-blue-700' },
                { name: 'AWS', time: 25.82, color: 'bg-blue-700' },
                { name: 'GCP', time: 25.82, color: 'bg-blue-700' },
              ].map((provider) => {
                const maxTime = 25.82;
                const width = (provider.time / maxTime) * 100;

                return (
                  <div
                    key={provider.name}
                    className="flex items-center gap-4 w-full"
                  >
                    <div className="w-14 text-sm truncate text-right text-muted-foreground">
                      {provider.name}
                    </div>
                    <div className="w-full h-8 bg-gray-100 rounded-md overflow-hidden">
                      <div
                        className={`h-full rounded-md transition-all ${provider.color}`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <div className="w-13 shrink-0 text-right font-mono text-gray-900 text-sm">
                      {provider.time.toFixed(2)}s
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-gray-900 text-right pt-1">
                For illustration purposes only
              </p>
            </div>
          </div>
        </section>

        {/* Learn More Section */}
        <section className="border-t px-4 py-8 sm:pt-24 sm:pb-16 sm:px-12">
          <div className="max-w-2xl mx-auto text-center space-y-4">
            <h2 className="font-semibold text-3xl tracking-tight sm:text-4xl">
              Learn more about worlds
            </h2>
            <p className="text-muted-foreground">
              To learn more about how worlds work or to create your own, check
              the docs. You can also build a custom world to connect workflows
              to any storage or queuing backend.
            </p>
            <div className="flex justify-center gap-3 mt-8">
              <Button asChild size="lg">
                <Link href="/docs/deploying/building-a-world">
                  World Interface Docs
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <a
                  href="https://github.com/vercel/workflow/blob/main/worlds-manifest.json"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Submit Your World
                </a>
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
