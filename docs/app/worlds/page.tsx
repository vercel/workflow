import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Globe } from '@/components/worlds/Globe';
import { WorldCardSimple } from '@/components/worlds/WorldCardSimple';
import { getWorldsData } from '@/lib/worlds-data';

export const metadata: Metadata = {
  title: 'Worlds | Workflow DevKit',
  description:
    'The World abstraction allows workflows to run anywhere — locally, on Vercel, or on any cloud. The runtime, queues, and persistence are modular and entirely swappable.',
};

export default async function WorldsPage() {
  const data = await getWorldsData();

  // Sort worlds: official first, then community, alphabetically within each group
  const sortedWorlds = Object.entries(data.worlds).sort(([, a], [, b]) => {
    if (a.type === 'official' && b.type !== 'official') return -1;
    if (a.type !== 'official' && b.type === 'official') return 1;
    return a.name.localeCompare(b.name);
  });

  const officialCount = sortedWorlds.filter(
    ([, w]) => w.type === 'official'
  ).length;
  const communityCount = sortedWorlds.filter(
    ([, w]) => w.type === 'community'
  ).length;
  const passingCount = sortedWorlds.filter(
    ([, w]) => w.e2e?.status === 'passing'
  ).length;

  return (
    <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter">
      <div className="mx-auto w-full max-w-[1080px]">
        {/* Hero Section */}
        <section className="mt-[var(--fd-nav-height)] relative overflow-hidden px-4 pt-16 sm:pt-24 pb-16 text-center">
          {/* Globe backdrop */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Globe className="w-full max-w-[1200px] opacity-30 translate-y-[30%]" />
          </div>

          {/* Content */}
          <div className="relative z-10 mx-auto w-full max-w-3xl space-y-5">
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

        {/* Stats */}
        <div className="border-y px-4 py-6">
          <div className="flex flex-wrap justify-center gap-3">
            <Badge variant="outline" className="text-sm py-1 px-3">
              {sortedWorlds.length} Worlds
            </Badge>
            <Badge variant="outline" className="text-sm py-1 px-3">
              {officialCount} Official
            </Badge>
            <Badge variant="outline" className="text-sm py-1 px-3">
              {communityCount} Community
            </Badge>
            <Badge
              variant="outline"
              className="text-sm py-1 px-3 bg-green-500/10 text-green-600 border-green-500/20"
            >
              {passingCount} Fully Compatible
            </Badge>
          </div>
        </div>

        {/* World Cards Grid */}
        <section className="px-4 py-8 sm:py-12">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedWorlds.map(([id, world]) => (
              <WorldCardSimple key={id} id={id} world={world} />
            ))}
          </div>
        </section>

        {/* Provider Benchmarks Section */}
        <section className="border-t px-4 py-12 sm:py-16">
          <div className="max-w-4xl mx-auto">
            <div className="flex flex-col lg:flex-row gap-8 lg:gap-12 items-center">
              {/* Left: Text content */}
              <div className="flex-1 space-y-4 text-center lg:text-left">
                <h2 className="font-semibold text-2xl tracking-tight sm:text-3xl">
                  Provider Benchmarks
                </h2>
                <p className="text-muted-foreground">
                  See how workflows compare across the different worlds deployed
                  on different providers. Lower execution time means faster
                  workflows.
                </p>
                <Button variant="secondary" size="lg" className="mt-2" disabled>
                  Coming Soon
                </Button>
              </div>

              {/* Right: Benchmark preview visualization */}
              <div className="flex-1 w-full max-w-md space-y-3">
                {/* Header row */}
                <div className="flex items-center gap-3 text-xs text-muted-foreground uppercase tracking-wider">
                  <div className="w-16" />
                  <div className="flex-1" />
                  <div className="w-14 text-right font-semibold">Perf</div>
                </div>
                {/* Benchmark bars */}
                {[
                  { name: 'Local', time: 10.76, isFastest: true },
                  { name: 'Vercel', time: 19.37, isFastest: false },
                  { name: 'AWS', time: 25.82, isFastest: false },
                  { name: 'GCP', time: 25.82, isFastest: false },
                ].map((provider) => {
                  const maxTime = 25.82;
                  const width = (provider.time / maxTime) * 100;

                  return (
                    <div
                      key={provider.name}
                      className="flex items-center gap-3"
                    >
                      <div className="w-16 text-sm truncate text-right text-muted-foreground">
                        {provider.name}
                      </div>
                      <div className="flex-1 h-8 bg-muted rounded-md overflow-hidden">
                        <div
                          className={`h-full rounded-md transition-all ${
                            provider.isFastest
                              ? 'bg-green-500'
                              : 'bg-primary/40'
                          }`}
                          style={{ width: `${width}%` }}
                        />
                      </div>
                      <div className="w-14 text-right font-mono text-sm">
                        {provider.time.toFixed(2)}s
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground/60 italic pt-1">
                  For illustration purposes only
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* What is a World? Section */}
        <section className="border-t px-4 py-8 sm:py-12 sm:px-12">
          <div className="max-w-3xl mx-auto space-y-6">
            <h2 className="font-semibold text-2xl tracking-tight sm:text-3xl text-center">
              What is a World?
            </h2>
            <div className="grid gap-6 sm:grid-cols-3">
              <div>
                <h3 className="font-semibold mb-2">Workflow Storage</h3>
                <p className="text-sm text-muted-foreground">
                  Persists workflow state and event logs across function
                  invocations.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-2">Step Execution</h3>
                <p className="text-sm text-muted-foreground">
                  Manages step function invocations with retries and error
                  handling.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-2">Message Passing</h3>
                <p className="text-sm text-muted-foreground">
                  Handles communication between the orchestrator and step
                  functions.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Contributing Section */}
        <section className="border-t px-4 py-8 sm:py-12 sm:px-12">
          <div className="max-w-2xl mx-auto text-center space-y-4">
            <h2 className="font-semibold text-xl tracking-tight sm:text-2xl">
              Build Your Own World
            </h2>
            <p className="text-muted-foreground">
              Want to create a World for your infrastructure? Check out the
              World interface documentation and add your implementation to this
              dashboard.
            </p>
            <div className="flex justify-center gap-3">
              <Button asChild variant="outline">
                <Link href="/docs/deploying/world">World Interface Docs</Link>
              </Button>
              <Button asChild variant="outline">
                <a
                  href="https://github.com/vercel/workflow/blob/main/worlds-manifest.json"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Add Your World
                </a>
              </Button>
            </div>
          </div>
        </section>

        {/* Last Updated Footer */}
        <div className="border-t px-4 py-6 text-center text-xs text-muted-foreground">
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
      </div>
    </div>
  );
}
