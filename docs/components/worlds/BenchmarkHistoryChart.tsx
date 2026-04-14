"use client";

import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartConfig } from "@/components/ui/chart";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatTime } from "./types";

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
    label: "Time",
    color: "var(--ds-blue-800)",
  },
  range: {
    label: "Range",
    color: "var(--ds-blue-800)",
  },
  ttfb: {
    label: "TTFB",
    color: "var(--ds-green-800)",
  },
  slurp: {
    label: "Slurp",
    color: "var(--ds-purple-900)",
  },
} satisfies ChartConfig;

type HistoryMode = "releases" | "commits";

export function BenchmarkHistoryChart({
  worldId,
  metricName,
  open,
  onOpenChange,
}: BenchmarkHistoryChartProps) {
  const [mode, setMode] = useState<HistoryMode>("releases");
  const [data, setData] = useState<BenchmarkHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  // Client-side cache: serve stale data instantly on mode switch,
  // then refresh in background.
  const cache = useRef<Record<string, BenchmarkHistoryPoint[]>>({});

  const fetchHistory = useCallback(async () => {
    const cacheKey = `${worldId}:${metricName}:${mode}`;
    const cached = cache.current[cacheKey];

    // Show cached data immediately if available
    if (cached) {
      setData(cached);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const res = await fetch(
        `/api/benchmark-history?worldId=${encodeURIComponent(worldId)}&metricName=${encodeURIComponent(metricName)}&mode=${mode}`,
      );

      if (!res.ok) {
        throw new Error(`Failed to fetch: ${res.status}`);
      }

      const history = await res.json();
      cache.current[cacheKey] = history;
      setData(history);
    } catch (err) {
      // Only show error if we have no cached data to fall back on
      if (!cached) {
        setError(
          err instanceof Error ? err.message : "Failed to fetch history",
        );
      }
    } finally {
      setLoading(false);
      setHasLoadedOnce(true);
    }
  }, [worldId, metricName, mode]);

  useEffect(() => {
    if (!open) return;
    fetchHistory();
  }, [open, fetchHistory]);

  // Check if this is a stream benchmark (has ttfb data)
  const isStreamBenchmark = data.some((d) => d.ttfb !== undefined);

  // Check if we have workflow min/max data (for showing range)
  const hasWorkflowRange = data.some(
    (d) => d.workflowMin !== undefined && d.workflowMax !== undefined,
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

  const modeLabel = mode === "releases" ? "releases" : "commits";

  const getGitHubUrl = (point: BenchmarkHistoryPoint) => {
    if (mode === "releases") {
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
          <DialogDescription className="text-sm text-muted-foreground">
            Performance history over the last {data.length} {modeLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[420px]">
          {/* Tabs for switching between releases and commits */}
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as HistoryMode)}
            variant="underline"
            className="mb-4"
          >
            <TabsList>
              <TabsTrigger value="releases" disabled={loading}>
                Releases
              </TabsTrigger>
              <TabsTrigger value="commits" disabled={loading}>
                Commits
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Loading skeleton matching the stat cards + chart layout */}
          {!hasLoadedOnce && data.length === 0 && (
            <div>
              <div className="grid gap-3 grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 rounded-lg" />
                ))}
              </div>
              <Skeleton className="h-64 w-full rounded-lg mt-3" />
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center text-destructive">
              {error}
            </div>
          )}

          {!error && data.length === 0 && hasLoadedOnce && (
            <div className="flex items-center justify-center text-muted-foreground">
              No historical data available
            </div>
          )}

          {!error &&
            data.length > 0 &&
            stats &&
            (() => {
              const statCards = [
                { label: "Samples", value: String(stats.samples ?? "—") },
                { label: "Time", value: formatTime(stats.current) },
                ...(isStreamBenchmark && stats.ttfb !== undefined
                  ? [
                      {
                        label: "TTFB",
                        value: formatTime(stats.ttfb),
                        colorClass: "text-green-900 dark:text-green-600",
                      },
                    ]
                  : []),
                ...(isStreamBenchmark && stats.slurp !== undefined
                  ? [
                      {
                        label: "Slurp",
                        value: formatTime(stats.slurp),
                        colorClass: "text-purple-900",
                      },
                    ]
                  : []),
                {
                  label: "Trend",
                  value: `${Math.abs(stats.trendPercent).toFixed(1)}%`,
                  colorClass:
                    stats.trendPercent < -1
                      ? "text-green-900 dark:text-green-600"
                      : stats.trendPercent > 1
                        ? "text-red-900 dark:text-red-800"
                        : "text-muted-foreground",
                  icon:
                    stats.trendPercent < -1
                      ? "down"
                      : stats.trendPercent > 1
                        ? "up"
                        : "flat",
                },
              ];

              return (
                <div
                  className={loading ? "opacity-50 pointer-events-none" : ""}
                >
                  {/* Stats summary */}
                  <div
                    className={`grid gap-3 mb-6 ${isStreamBenchmark ? "grid-cols-5" : "grid-cols-3"}`}
                  >
                    {statCards.map((stat) => (
                      <div
                        key={stat.label}
                        className="p-3 bg-background-200 rounded-lg"
                      >
                        <div
                          className={`text-lg font-semibold font-mono flex items-center gap-2 ${stat.colorClass ?? ""}`}
                        >
                          {stat.value}
                          {stat.icon === "down" && (
                            <TrendingDown className="h-5 w-5" />
                          )}
                          {stat.icon === "up" && (
                            <TrendingUp className="h-5 w-5" />
                          )}
                          {stat.icon === "flat" && (
                            <Minus className="h-5 w-5" />
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {stat.label}
                        </div>
                      </div>
                    ))}
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
                          d.workflowMin !== undefined &&
                          d.workflowMax !== undefined
                            ? d.workflowMax - d.workflowMin
                            : 0,
                      }))}
                      margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient
                          id="fillRange"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
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
                      <CartesianGrid
                        horizontal
                        vertical={false}
                        stroke="var(--ds-gray-400)"
                      />
                      <XAxis
                        dataKey="label"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        tick={{ fontSize: 10 }}
                        interval="equidistantPreserveStart"
                      />
                      <YAxis
                        tickFormatter={(value) => formatTime(value)}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        tick={{ fontSize: 10 }}
                        width={55}
                        domain={[0, "auto"]}
                      />
                      <ChartTooltip
                        isAnimationActive={false}
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
                            <div className="bg-popover rounded-lg shadow-[var(--ds-shadow-tooltip)] p-3 text-sm">
                              <div className="font-mono text-xs mb-2">
                                {label}
                              </div>
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                  <div
                                    className="h-2.5 w-2.5 rounded-[2px]"
                                    style={{
                                      backgroundColor:
                                        "var(--color-workflowTime)",
                                    }}
                                  />
                                  <span className="text-xs text-muted-foreground">
                                    Time:
                                  </span>
                                  <span className="font-mono font-medium text-xs">
                                    {point.workflowTime !== undefined
                                      ? formatTime(point.workflowTime)
                                      : "—"}
                                  </span>
                                </div>
                                {point.ttfb !== undefined && (
                                  <div className="flex items-center gap-2">
                                    <div
                                      className="h-2.5 w-2.5 rounded-[2px]"
                                      style={{
                                        backgroundColor: "var(--color-ttfb)",
                                      }}
                                    />
                                    <span className="text-xs text-muted-foreground">
                                      TTFB:
                                    </span>
                                    <span className="font-mono font-medium text-xs">
                                      {formatTime(point.ttfb)}
                                    </span>
                                  </div>
                                )}
                                {point.slurp !== undefined && (
                                  <div className="flex items-center gap-2">
                                    <div
                                      className="h-2.5 w-2.5 rounded-[2px]"
                                      style={{
                                        backgroundColor: "var(--color-slurp)",
                                      }}
                                    />
                                    <span className="text-xs text-muted-foreground">
                                      Slurp:
                                    </span>
                                    <span className="font-mono font-medium text-xs">
                                      {formatTime(point.slurp)}
                                    </span>
                                  </div>
                                )}
                                {hasRange && (
                                  <div className="text-xs text-muted-foreground">
                                    Range: {formatTime(point.workflowMin!)} –{" "}
                                    {formatTime(point.workflowMax!)}
                                  </div>
                                )}
                                {point.samples && (
                                  <div className="text-xs text-muted-foreground">
                                    Samples: {point.samples}
                                  </div>
                                )}
                                <div className="text-xs text-muted-foreground">
                                  {new Date(
                                    point.timestamp,
                                  ).toLocaleDateString()}
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
                            type="linear"
                            dataKey="displayMin"
                            stackId="range"
                            stroke="none"
                            fill="transparent"
                            isAnimationActive={false}
                          />
                          {/* Visible area from min to max (stacked on top of min) */}
                          <Area
                            type="linear"
                            dataKey="rangeHeight"
                            stackId="range"
                            stroke="none"
                            fill="url(#fillRange)"
                            isAnimationActive={false}
                          />
                        </>
                      )}
                      {/* Fill area under the line — only for single-line charts */}
                      {!isStreamBenchmark && (
                        <Area
                          type="linear"
                          dataKey="displayTime"
                          stroke="none"
                          fill="var(--ds-blue-800)"
                          fillOpacity={0.1}
                          isAnimationActive={false}
                        />
                      )}
                      {/* Line showing workflow time (primary metric) */}
                      <Line
                        type="linear"
                        dataKey="displayTime"
                        name="Workflow Time"
                        stroke="var(--color-workflowTime)"
                        strokeWidth={2}
                        isAnimationActive={false}
                        dot={{
                          fill: "var(--color-workflowTime)",
                          stroke: "var(--ds-background-100)",
                          strokeWidth: 1,
                          r: 2.5,
                          cursor: "pointer",
                        }}
                        activeDot={{
                          r: 4,
                          fill: "var(--color-workflowTime)",
                          strokeWidth: 0,
                          cursor: "pointer",
                          onClick: (_, event) => {
                            const point = (
                              event as unknown as {
                                payload: BenchmarkHistoryPoint;
                              }
                            ).payload;
                            if (point) {
                              window.open(getGitHubUrl(point), "_blank");
                            }
                          },
                        }}
                      />
                      {/* TTFB line for stream benchmarks */}
                      {isStreamBenchmark && (
                        <Line
                          type="linear"
                          dataKey="ttfb"
                          name="TTFB"
                          stroke="var(--color-ttfb)"
                          strokeWidth={2}
                          strokeDasharray="4 4"
                          isAnimationActive={false}
                          dot={{
                            fill: "var(--color-ttfb)",
                            strokeWidth: 0,
                            r: 2.5,
                          }}
                          activeDot={{
                            r: 4,
                            fill: "var(--color-ttfb)",
                            strokeWidth: 0,
                          }}
                        />
                      )}
                      {/* Slurp line for stream benchmarks */}
                      {isStreamBenchmark && (
                        <Line
                          type="linear"
                          dataKey="slurp"
                          name="Slurp"
                          stroke="var(--color-slurp)"
                          strokeWidth={2}
                          strokeDasharray="2 2"
                          isAnimationActive={false}
                          dot={{
                            fill: "var(--color-slurp)",
                            strokeWidth: 0,
                            r: 2.5,
                          }}
                          activeDot={{
                            r: 4,
                            fill: "var(--color-slurp)",
                            strokeWidth: 0,
                          }}
                        />
                      )}
                    </ComposedChart>
                  </ChartContainer>

                  <p className="text-xs text-muted-foreground text-center mt-4">
                    Lower is better. Results may vary due to CI environment,
                    network conditions, and other factors.
                  </p>
                </div>
              );
            })()}
        </div>
      </DialogContent>
    </Dialog>
  );
}
