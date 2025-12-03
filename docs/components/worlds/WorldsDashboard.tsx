'use client';

import { useState } from 'react';
import { WorldCard } from './WorldCard';
import { BenchmarkChart, BenchmarkBar } from './BenchmarkChart';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { WorldsStatus } from './types';

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
    passing: worlds.filter(([, w]) => w.e2e?.status === 'passing').length,
    partial: worlds.filter(([, w]) => w.e2e?.status === 'partial').length,
    withBenchmarks: worlds.filter(([, w]) => w.benchmark?.status === 'measured')
      .length,
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
        <Badge variant="outline" className="text-sm py-1 px-3">
          {stats.total} Worlds
        </Badge>
        <Badge variant="outline" className="text-sm py-1 px-3">
          {stats.official} Official
        </Badge>
        <Badge variant="outline" className="text-sm py-1 px-3">
          🌐 {stats.community} Community
        </Badge>
        <Badge
          variant="outline"
          className="text-sm py-1 px-3 bg-green-500/10 text-green-600 border-green-500/20"
        >
          ✅ {stats.passing} Fully Compatible
        </Badge>
        {stats.partial > 0 && (
          <Badge
            variant="outline"
            className="text-sm py-1 px-3 bg-yellow-500/10 text-yellow-600 border-yellow-500/20"
          >
            ⚠️ {stats.partial} Partial
          </Badge>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="benchmarks">Benchmarks</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 pt-4">
          {/* Filter */}
          <div className="flex gap-2">
            <button
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
        </TabsContent>

        <TabsContent value="benchmarks" className="space-y-8 pt-4">
          {/* Benchmark comparison */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Performance Comparison</h3>
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
        </TabsContent>
      </Tabs>

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
