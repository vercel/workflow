'use client';

import { useMemo } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { WorldsStatus } from './types';

interface BenchmarkChartProps {
  data: WorldsStatus;
  benchmarkName?: string;
}

export function BenchmarkChart({ data, benchmarkName }: BenchmarkChartProps) {
  const { worlds, benchmarks, fastest } = useMemo(() => {
    const worldEntries = Object.entries(data.worlds).filter(
      ([, w]) => w.benchmark?.metrics
    );

    // Get all unique benchmark names
    const allBenchmarks = new Set<string>();
    for (const [, world] of worldEntries) {
      if (world.benchmark?.metrics) {
        for (const name of Object.keys(world.benchmark.metrics)) {
          allBenchmarks.add(name);
        }
      }
    }

    // Filter to specific benchmark if provided
    const benchmarkList = benchmarkName
      ? [benchmarkName]
      : Array.from(allBenchmarks).sort();

    // Find fastest for each benchmark
    const fastestByBench: Record<string, { worldId: string; time: number }> =
      {};
    for (const bench of benchmarkList) {
      let fastest: { worldId: string; time: number } | null = null;
      for (const [worldId, world] of worldEntries) {
        const metric = world.benchmark?.metrics?.[bench];
        if (metric && (!fastest || metric.mean < fastest.time)) {
          fastest = { worldId, time: metric.mean };
        }
      }
      if (fastest) {
        fastestByBench[bench] = fastest;
      }
    }

    return {
      worlds: worldEntries,
      benchmarks: benchmarkList,
      fastest: fastestByBench,
    };
  }, [data, benchmarkName]);

  if (worlds.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No benchmark data available.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px]">Benchmark</TableHead>
            {worlds.map(([id, world]) => (
              <TableHead key={id} className="text-right">
                {world.type === 'community' && '🌐 '}
                {world.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {benchmarks.map((bench) => (
            <TableRow key={bench}>
              <TableCell className="font-medium text-sm">{bench}</TableCell>
              {worlds.map(([worldId, world]) => {
                const metric = world.benchmark?.metrics?.[bench];
                const isFastest = fastest[bench]?.worldId === worldId;
                const fastestTime = fastest[bench]?.time || 1;
                const factor = metric ? metric.mean / fastestTime : null;

                return (
                  <TableCell
                    key={worldId}
                    className={cn(
                      'text-right font-mono text-sm',
                      isFastest && 'text-green-600 font-semibold'
                    )}
                  >
                    {metric ? (
                      <span>
                        {isFastest && '🥇 '}
                        {metric.mean.toFixed(0)}ms
                        {!isFastest && factor && (
                          <span className="text-muted-foreground text-xs ml-1">
                            ({factor.toFixed(1)}x)
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// Simple bar visualization for a single benchmark across worlds
export function BenchmarkBar({
  data,
  benchmarkName,
}: {
  data: WorldsStatus;
  benchmarkName: string;
}) {
  const { worlds, maxTime, minTime } = useMemo(() => {
    const worldEntries = Object.entries(data.worlds)
      .filter(([, w]) => w.benchmark?.metrics?.[benchmarkName])
      .map(([id, w]) => ({
        id,
        name: w.name,
        type: w.type,
        time: w.benchmark!.metrics[benchmarkName].mean,
      }))
      .sort((a, b) => a.time - b.time);

    const times = worldEntries.map((w) => w.time);
    return {
      worlds: worldEntries,
      maxTime: Math.max(...times, 1),
      minTime: Math.min(...times, 0),
    };
  }, [data, benchmarkName]);

  if (worlds.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {worlds.map((world, index) => {
        const width = (world.time / maxTime) * 100;
        const isFastest = index === 0;

        return (
          <div key={world.id} className="flex items-center gap-3">
            <div className="w-24 text-sm truncate">
              {world.type === 'community' && '🌐 '}
              {world.name}
            </div>
            <div className="flex-1 h-6 bg-muted rounded overflow-hidden">
              <div
                className={cn(
                  'h-full rounded transition-all',
                  isFastest ? 'bg-green-500' : 'bg-primary/60'
                )}
                style={{ width: `${width}%` }}
              />
            </div>
            <div className="w-20 text-right font-mono text-sm">
              {isFastest && '🥇 '}
              {world.time.toFixed(0)}ms
            </div>
          </div>
        );
      })}
    </div>
  );
}
