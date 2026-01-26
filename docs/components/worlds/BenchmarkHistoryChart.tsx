'use client';

import { useEffect, useState } from 'react';
import { Area, ComposedChart, XAxis, YAxis, Line } from 'recharts';
import { Loader2, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ChartConfig } from '@/components/ui/chart';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';
import { formatTime } from './types';

interface BenchmarkHistoryPoint {
  label: string;
  commit: string;
  timestamp: string;
  mean: number;
  min: number;
  max: number;
  samples?: number;
  workflowTime?: number;
  workflowMin?: number;
  workflowMax?: number;
  ttfb?: number;
  slurp?: number;
}

interface BenchmarkHistoryChartProps {
  worldId: string;
  metricName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const chartConfig = {
  workflowTime: {
    label: 'Time',
    theme: {
      light: 'hsl(221 83% 53%)', // blue-600
      dark: 'hsl(217 91% 60%)', // blue-500
    },
  },
  range: {
    label: 'Range',
    theme: {
      light: 'hsl(221 83% 53%)', // blue-600
      dark: 'hsl(217 91% 60%)', // blue-500
    },
  },
  ttfb: {
    label: 'TTFB',
    theme: {
      light: 'hsl(142 76% 36%)', // green-600
      dark: 'hsl(142 71% 45%)', // green-500
    },
  },
  slurp: {
    label: 'Slurp',
    theme: {
      light: 'hsl(271 91% 65%)', // purple-500
      dark: 'hsl(270 95% 75%)', // purple-400
    },
  },
} satisfies ChartConfig;

type HistoryMode = 'releases' | 'commits';

export function BenchmarkHistoryChart({
  worldId,
  metricName,
  open,
  onOpenChange,
}: BenchmarkHistoryChartProps) {
  const [mode, setMode] = useState<HistoryMode>('releases');
  const [data, setData] = useState<BenchmarkHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  useEffect(() => {
    if (!open) return;

    async function fetchHistory() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(
          `/api/benchmark-history?worldId=${encodeURIComponent(worldId)}&metricName=${encodeURIComponent(metricName)}&mode=${mode}`
        );

        if (!res.ok) {
          throw new Error(`Failed to fetch: ${res.status}`);
        }

        const history = await res.json();
        setData(history);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to fetch history'
        );
      } finally {
        setLoading(false);
        setHasLoadedOnce(true);
      }
    }

    fetchHistory();
  }, [open, worldId, metricName, mode]);

  // Check if this is a stream benchmark (has ttfb data)
  const isStreamBenchmark = data.some((d) => d.ttfb !== undefined);

  // Check if we have workflow min/max data (for showing range)
  const hasWorkflowRange = data.some(
    (d) => d.workflowMin !== undefined && d.workflowMax !== undefined
  );

  // Calculate stats for the chart - use workflowTime when available
  const stats =
    data.length > 0
      ? (() => {
          const latestPoint = data[data.length - 1];
          const current = latestPoint?.workflowTime ?? 0;
          const oldestPoint = data[0];
          const oldest = oldestPoint?.workflowTime ?? current;
          // Positive trend means slower (worse), negative means faster (better)
          const trendPercent =
            oldest !== 0 ? ((current - oldest) / oldest) * 100 : 0;
          return {
            samples: latestPoint?.samples,
            current,
            trendPercent,
            ttfb: latestPoint?.ttfb,
            slurp: latestPoint?.slurp,
          };
        })()
      : null;

  const modeLabel = mode === 'releases' ? 'releases' : 'commits';

  const getGitHubUrl = (point: BenchmarkHistoryPoint) => {
    if (mode === 'releases') {
      return `https://github.com/vercel/workflow/releases/tag/workflow@${point.label}`;
    }
    return `https://github.com/vercel/workflow/commit/${point.commit}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {metricName}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Performance history over the last {data.length} {modeLabel}
          </p>
        </DialogHeader>

        <div className="mt-4">
          {/* Tabs for switching between releases and commits */}
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as HistoryMode)}
            className="mb-4"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="releases" disabled={loading}>
                Releases
              </TabsTrigger>
              <TabsTrigger value="commits" disabled={loading}>
                Commits
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Show spinner only on initial load when there's no data */}
          {loading && data.length === 0 && (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-64 text-destructive">
              {error}
            </div>
          )}

          {!error && data.length === 0 && !loading && (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              No historical data available
            </div>
          )}

          {!error && data.length > 0 && stats && (
            <div className={loading ? 'opacity-50 pointer-events-none' : ''}>
              {/* Stats summary */}
              <div
                className={`grid gap-4 mb-6 ${isStreamBenchmark ? 'grid-cols-5' : 'grid-cols-3'}`}
              >
                <div className="text-center">
                  <div className="text-2xl font-semibold font-mono">
                    {stats.samples ?? '—'}
                  </div>
                  <div className="text-xs text-muted-foreground">Samples</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-semibold font-mono">
                    {formatTime(stats.current)}
                  </div>
                  <div className="text-xs text-muted-foreground">Time</div>
                </div>
                {isStreamBenchmark && stats.ttfb !== undefined && (
                  <div className="text-center">
                    <div className="text-2xl font-semibold font-mono text-green-600 dark:text-green-500">
                      {formatTime(stats.ttfb)}
                    </div>
                    <div className="text-xs text-muted-foreground">TTFB</div>
                  </div>
                )}
                {isStreamBenchmark && stats.slurp !== undefined && (
                  <div className="text-center">
                    <div className="text-2xl font-semibold font-mono text-purple-500 dark:text-purple-400">
                      {formatTime(stats.slurp)}
                    </div>
                    <div className="text-xs text-muted-foreground">Slurp</div>
                  </div>
                )}
                <div className="text-center">
                  <div
                    className={`text-2xl font-semibold font-mono flex items-center justify-center gap-1 ${
                      stats.trendPercent < -1
                        ? 'text-green-600 dark:text-green-500'
                        : stats.trendPercent > 1
                          ? 'text-red-600 dark:text-red-500'
                          : 'text-muted-foreground'
                    }`}
                  >
                    {stats.trendPercent < -1 ? (
                      <TrendingDown className="h-5 w-5" />
                    ) : stats.trendPercent > 1 ? (
                      <TrendingUp className="h-5 w-5" />
                    ) : (
                      <Minus className="h-5 w-5" />
                    )}
                    {Math.abs(stats.trendPercent).toFixed(1)}%
                  </div>
                  <div className="text-xs text-muted-foreground">Trend</div>
                </div>
              </div>

              {/* Chart */}
              <ChartContainer config={chartConfig} className="h-64 w-full">
                <ComposedChart
                  data={data.map((d) => ({
                    ...d,
                    // Use workflowTime as the display value
                    displayTime: d.workflowTime ?? 0,
                    // For range area: only show if we have workflow min/max
                    displayMin: d.workflowMin ?? 0,
                    rangeHeight:
                      d.workflowMin !== undefined && d.workflowMax !== undefined
                        ? d.workflowMax - d.workflowMin
                        : 0,
                  }))}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="fillRange" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor="var(--color-range)"
                        stopOpacity={0.25}
                      />
                      <stop
                        offset="100%"
                        stopColor="var(--color-range)"
                        stopOpacity={0.1}
                      />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 10 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={(value) => formatTime(value)}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 10 }}
                    width={55}
                    domain={[0, 'auto']}
                  />
                  <ChartTooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const point = payload[0]
                        ?.payload as BenchmarkHistoryPoint & {
                        displayTime: number;
                      };
                      if (!point) return null;
                      const hasRange =
                        point.workflowMin !== undefined &&
                        point.workflowMax !== undefined;
                      return (
                        <div className="bg-popover border rounded-lg shadow-lg p-3 text-sm">
                          <div className="font-mono text-xs mb-2">{label}</div>
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <div
                                className="h-2.5 w-2.5 rounded-[2px]"
                                style={{
                                  backgroundColor: 'var(--color-workflowTime)',
                                }}
                              />
                              <span className="text-xs text-muted-foreground">
                                Time:
                              </span>
                              <span className="font-mono font-medium">
                                {point.workflowTime !== undefined
                                  ? formatTime(point.workflowTime)
                                  : '—'}
                              </span>
                            </div>
                            {point.ttfb !== undefined && (
                              <div className="flex items-center gap-2">
                                <div
                                  className="h-2.5 w-2.5 rounded-[2px]"
                                  style={{
                                    backgroundColor: 'var(--color-ttfb)',
                                  }}
                                />
                                <span className="text-xs text-muted-foreground">
                                  TTFB:
                                </span>
                                <span className="font-mono font-medium">
                                  {formatTime(point.ttfb)}
                                </span>
                              </div>
                            )}
                            {point.slurp !== undefined && (
                              <div className="flex items-center gap-2">
                                <div
                                  className="h-2.5 w-2.5 rounded-[2px]"
                                  style={{
                                    backgroundColor: 'var(--color-slurp)',
                                  }}
                                />
                                <span className="text-xs text-muted-foreground">
                                  Slurp:
                                </span>
                                <span className="font-mono font-medium">
                                  {formatTime(point.slurp)}
                                </span>
                              </div>
                            )}
                            {hasRange && (
                              <div className="text-xs text-muted-foreground">
                                Range: {formatTime(point.workflowMin!)} –{' '}
                                {formatTime(point.workflowMax!)}
                              </div>
                            )}
                            {point.samples && (
                              <div className="text-xs text-muted-foreground">
                                Samples: {point.samples}
                              </div>
                            )}
                            <div className="text-xs text-muted-foreground">
                              {new Date(point.timestamp).toLocaleDateString()}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              Click point to open on GitHub
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  />
                  {/* Only show range area if we have workflow min/max data */}
                  {hasWorkflowRange && (
                    <>
                      {/* Invisible base area up to min value */}
                      <Area
                        type="monotone"
                        dataKey="displayMin"
                        stackId="range"
                        stroke="none"
                        fill="transparent"
                        isAnimationActive={hasLoadedOnce}
                      />
                      {/* Visible area from min to max (stacked on top of min) */}
                      <Area
                        type="monotone"
                        dataKey="rangeHeight"
                        stackId="range"
                        stroke="none"
                        fill="url(#fillRange)"
                        isAnimationActive={hasLoadedOnce}
                      />
                    </>
                  )}
                  {/* Line showing workflow time (primary metric) */}
                  <Line
                    type="monotone"
                    dataKey="displayTime"
                    name="Workflow Time"
                    stroke="var(--color-workflowTime)"
                    strokeWidth={2}
                    isAnimationActive={hasLoadedOnce}
                    dot={{
                      fill: 'var(--color-workflowTime)',
                      strokeWidth: 0,
                      r: 3,
                      cursor: 'pointer',
                    }}
                    activeDot={{
                      r: 6,
                      fill: 'var(--color-workflowTime)',
                      strokeWidth: 0,
                      cursor: 'pointer',
                      onClick: (_, event) => {
                        const point = (
                          event as unknown as { payload: BenchmarkHistoryPoint }
                        ).payload;
                        if (point) {
                          window.open(getGitHubUrl(point), '_blank');
                        }
                      },
                    }}
                  />
                  {/* TTFB line for stream benchmarks */}
                  {isStreamBenchmark && (
                    <Line
                      type="monotone"
                      dataKey="ttfb"
                      name="TTFB"
                      stroke="var(--color-ttfb)"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      isAnimationActive={hasLoadedOnce}
                      dot={{
                        fill: 'var(--color-ttfb)',
                        strokeWidth: 0,
                        r: 3,
                      }}
                      activeDot={{
                        r: 6,
                        fill: 'var(--color-ttfb)',
                        strokeWidth: 0,
                      }}
                    />
                  )}
                  {/* Slurp line for stream benchmarks */}
                  {isStreamBenchmark && (
                    <Line
                      type="monotone"
                      dataKey="slurp"
                      name="Slurp"
                      stroke="var(--color-slurp)"
                      strokeWidth={2}
                      strokeDasharray="2 2"
                      isAnimationActive={hasLoadedOnce}
                      dot={{
                        fill: 'var(--color-slurp)',
                        strokeWidth: 0,
                        r: 3,
                      }}
                      activeDot={{
                        r: 6,
                        fill: 'var(--color-slurp)',
                        strokeWidth: 0,
                      }}
                    />
                  )}
                </ComposedChart>
              </ChartContainer>

              <p className="text-xs text-muted-foreground text-center mt-4">
                Lower is better. Results may vary due to CI environment, network
                conditions, and other factors.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
