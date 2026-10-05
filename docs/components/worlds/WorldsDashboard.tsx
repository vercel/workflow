'use client';

import { Badge } from '@vercel/geistdocs/components/badge';
import {
  TabContent,
  TabsWithChildren,
} from '@vercel/geistdocs/components/tabs-with-children';
import { useState } from 'react';
import { BenchmarkBar, BenchmarkChart } from './BenchmarkChart';
import type { WorldsStatus } from './types';
import { WorldCard } from './WorldCard';

interface WorldsDashboardProps {
  data: WorldsStatus;
}

export function WorldsDashboard({ data }: WorldsDashboardProps) {
  const [filter, setFilter] = useState<'all' | 'official' | 'community'>('all');

  const worlds = Object.entries(data.worlds);
  const officialWorlds = worlds.filter(([, w]) => w.type === 'official');
  const communityWorlds = worlds.filter(([, w]) => w.type === 'community');

  const filteredWorlds =
    filter === 'all'
      ? worlds
      : filter === 'official'
        ? officialWorlds
        : communityWorlds;

  // Calculate summary stats
  const stats = {
    total: worlds.length,
    official: officialWorlds.length,
    community: communityWorlds.length,
  };

  // Get benchmark names for the bar chart
  const benchmarkNames = new Set<string>();
  for (const [, world] of worlds) {
    if (world.benchmark?.metrics) {
      for (const name of Object.keys(world.benchmark.metrics)) {
        benchmarkNames.add(name);
      }
    }
  }
  const sortedBenchmarks = Array.from(benchmarkNames).sort();

  return (
    <div className="space-y-8">
      {/* Summary */}
      <div className="flex flex-wrap gap-3">
        <Badge variant="pill" size="lg">
          {stats.total} Worlds
        </Badge>
        <Badge variant="pill" size="lg">
          {stats.official} Official
        </Badge>
        <Badge variant="pill" size="lg">
          🌐 {stats.community} Community
        </Badge>
      </div>

      {/* Tabs */}
      <TabsWithChildren
        ariaLabel="Worlds dashboard"
        className="w-full"
        tabs={['Overview', 'Benchmarks']}
      >
        <TabContent order={1} className="space-y-6 pt-4">
          {/* Filter */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                filter === 'all'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80'
              }`}
            >
              All ({stats.total})
            </button>
            <button
              type="button"
              onClick={() => setFilter('official')}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                filter === 'official'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80'
              }`}
            >
              Official ({stats.official})
            </button>
            <button
              type="button"
              onClick={() => setFilter('community')}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                filter === 'community'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80'
              }`}
            >
              Community ({stats.community})
            </button>
          </div>

          {/* World Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredWorlds.map(([id, world]) => (
              <WorldCard key={id} id={id} world={world} />
            ))}
          </div>
        </TabContent>

        <TabContent order={2} className="space-y-8 pt-4">
          {/* Benchmark comparison */}
          <div className="space-y-4">
            <h3 className="text-heading-20">Performance Comparison</h3>
            <p className="text-sm text-muted-foreground">
              Average workflow execution time across all worlds. Lower is
              better.
            </p>
            <BenchmarkChart data={data} />
          </div>

          {/* Individual benchmark bars */}
          {sortedBenchmarks.slice(0, 3).map((benchName) => (
            <div key={benchName} className="space-y-3">
              <h4 className="text-md font-medium">{benchName}</h4>
              <BenchmarkBar data={data} benchmarkName={benchName} />
            </div>
          ))}
        </TabContent>
      </TabsWithChildren>

      {/* Last updated */}
      <div className="text-xs text-muted-foreground border-t pt-4">
        Last updated: {new Date(data.lastUpdated).toLocaleString()}
        {data.commit && (
          <>
            {' · '}
            Commit:{' '}
            <code className="text-xs bg-muted px-1 rounded">
              {data.commit.slice(0, 7)}
            </code>
          </>
        )}
      </div>
    </div>
  );
}
