import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  BenchmarkChart,
  BenchmarkBar,
} from '@/components/worlds/BenchmarkChart';
import { getWorldsData } from '@/lib/worlds-data';

export const metadata: Metadata = {
  title: 'Compare World Benchmarks - Workflow',
  description:
    'Compare performance benchmarks across all Workflow World implementations.',
  robots: {
    index: false,
    follow: false,
  },
};

export default async function CompareBenchmarksPage() {
  const data = await getWorldsData();

  // Get all unique benchmark names
  const benchmarkNames = new Set<string>();
  for (const world of Object.values(data.worlds)) {
    if (world.benchmark?.metrics) {
      for (const name of Object.keys(world.benchmark.metrics)) {
        benchmarkNames.add(name);
      }
    }
  }
  const sortedBenchmarks = Array.from(benchmarkNames).sort();

  return (
    <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter">
      <div className="mx-auto w-full max-w-[1080px]">
        {/* Hero Section */}
        <section className="mt-[var(--fd-nav-height)] space-y-6 px-4 pt-16 sm:pt-24 pb-12 text-center border-b">
          <div className="mx-auto w-full max-w-3xl space-y-4">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              Benchmark Comparison
            </h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto text-balance">
              Compare workflow execution performance across all World
              implementations. Lower times are better.
            </p>
          </div>
          <Button
            asChild
            variant="outline"
            size="lg"
            className="h-[44px] text-base"
          >
            <Link href="/worlds">Back to Worlds</Link>
          </Button>
        </section>

        {/* Comparison Table */}
        <section className="px-4 py-8 sm:py-12 sm:px-12 border-b">
          <div className="space-y-6">
            <h2 className="font-semibold text-xl tracking-tight sm:text-2xl">
              Performance Overview
            </h2>
            <p className="text-muted-foreground">
              Average workflow execution time across different benchmark
              scenarios. Times shown are mean values in milliseconds.
            </p>
            <BenchmarkChart data={data} />
          </div>
        </section>

        {/* Individual Benchmark Bars */}
        <section className="px-4 py-8 sm:py-12 sm:px-12">
          <div className="space-y-8">
            <h2 className="font-semibold text-xl tracking-tight sm:text-2xl">
              Individual Benchmarks
            </h2>
            {sortedBenchmarks.map((benchName) => (
              <div
                key={benchName}
                className="space-y-4 pb-6 border-b last:border-b-0"
              >
                <h3 className="font-medium text-lg">{benchName}</h3>
                <BenchmarkBar data={data} benchmarkName={benchName} />
              </div>
            ))}
            {sortedBenchmarks.length === 0 && (
              <p className="text-muted-foreground">
                No benchmark data is currently available.
              </p>
            )}
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
