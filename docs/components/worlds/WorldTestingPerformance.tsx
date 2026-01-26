'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  XCircle,
  Clock,
  TrendingUp,
  Info,
  Timer,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatTime, type World } from './types';
import { BenchmarkHistoryChart } from './BenchmarkHistoryChart';

const TimeColumnHeader = () => (
  <div className="flex items-center justify-end gap-1">
    <span>Time</span>
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[200px]">
        Time from workflow created to workflow completed
      </TooltipContent>
    </Tooltip>
  </div>
);

const TTFBColumnHeader = () => (
  <div className="flex items-center justify-end gap-1">
    <span>TTFB</span>
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[200px]">
        Time to first byte
      </TooltipContent>
    </Tooltip>
  </div>
);

const SlurpColumnHeader = () => (
  <div className="flex items-center justify-end gap-1">
    <span>Slurp</span>
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[200px]">
        Time from first byte to stream completion
      </TooltipContent>
    </Tooltip>
  </div>
);

// The main benchmark used for the PERF metric
const PERF_BENCHMARK_NAME = 'workflow with 10 sequential steps';

interface WorldTestingPerformanceProps {
  worldId: string;
  world: World;
  meta: {
    lastUpdated: string;
    commit: string | null;
    branch: string | null;
  };
}

const statusConfig = {
  passing: {
    label: 'Passing',
    icon: CheckCircle2,
    className: 'bg-green-500/10 text-green-600 border-green-500/20',
  },
  partial: {
    label: 'Partial',
    icon: AlertCircle,
    className: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
  },
  failing: {
    label: 'Failing',
    icon: XCircle,
    className: 'bg-red-500/10 text-red-600 border-red-500/20',
  },
  pending: {
    label: 'Pending',
    icon: Clock,
    className: 'bg-muted text-muted-foreground',
  },
};

export function WorldTestingPerformance({
  worldId,
  world,
  meta,
}: WorldTestingPerformanceProps) {
  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);

  const e2e = world.e2e;
  const benchmark = world.benchmark;

  const hasE2E = !!e2e;
  const hasBenchmarks =
    benchmark?.metrics && Object.keys(benchmark.metrics).length > 0;

  // E2E calculations - use nextjs-turbopack data for canonical scoring
  const turbopackData = e2e?.nextjsTurbopack;
  const hasFrameworkData = !!turbopackData;

  // Canonical scoring based on nextjs-turbopack
  const scoringPassed = turbopackData
    ? turbopackData.passed
    : (e2e?.passed ?? 0);
  const scoringFailed = turbopackData
    ? turbopackData.failed
    : (e2e?.failed ?? 0);
  const scoringTotal = turbopackData
    ? turbopackData.total
    : (e2e?.total ?? 0) - (e2e?.skipped ?? 0);
  // Skipped = total - passed - failed
  const scoringSkipped = scoringTotal - scoringPassed - scoringFailed;

  // For percentage: passed / (passed + failed) - excludes skipped tests
  // If failed === 0, that's 100% passing regardless of skipped count
  const testsRan = scoringPassed + scoringFailed;
  const displayProgress =
    testsRan > 0 ? Math.round((scoringPassed / testsRan) * 100) : 0;

  const status = e2e?.status ?? 'pending';
  const config = statusConfig[status];
  const StatusIcon = config.icon;

  // Benchmark calculations - separate standard and stream benchmarks
  const allMetrics =
    hasBenchmarks && benchmark.metrics
      ? Object.entries(benchmark.metrics).sort(([a], [b]) => a.localeCompare(b))
      : [];

  // Stream benchmarks have ttfb field
  const standardMetrics = allMetrics.filter(([, metric]) => !metric.ttfb);
  const streamMetrics = allMetrics.filter(([, metric]) => metric.ttfb);

  // Check if we have workflow min/max data (for showing range columns)
  const hasWorkflowRange = allMetrics.some(
    ([, metric]) =>
      metric.workflowMin !== undefined && metric.workflowMax !== undefined
  );

  return (
    <section id="testing">
      <div className="space-y-8">
        {/* E2E Tests Subsection */}
        <div className="space-y-4">
          <h3 className="font-semibold text-lg tracking-tight">E2E Tests</h3>
          {hasE2E ? (
            <>
              {/* Summary - based on nextjs-turbopack for canonical scoring */}
              <div className="flex flex-wrap items-center gap-4">
                <Badge
                  className={cn('gap-1 text-sm py-1 px-3', config.className)}
                >
                  <StatusIcon className="h-4 w-4" />
                  {config.label}
                </Badge>
                <span className="text-lg font-medium">
                  {displayProgress}% passing
                </span>
              </div>

              {/* Disclaimer about scoring methodology */}
              <p className="text-sm text-muted-foreground">
                {hasFrameworkData
                  ? 'Spec compliance is tested against Next.js (Turbopack) built in production mode and started with `next start`.'
                  : 'E2E test pass rate across all tests run for this world.'}
                {meta.commit && (
                  <>
                    {' '}
                    <a
                      href={`https://github.com/vercel/workflow/commit/${meta.commit}/checks`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground hover:underline"
                    >
                      View CI run →
                    </a>
                  </>
                )}
              </p>

              {/* Details - show pass/fail/skipped counts */}
              <div className="grid gap-4 sm:grid-cols-4 text-sm">
                <div className="p-4 rounded-lg border bg-card">
                  <div className="text-2xl font-semibold text-green-600">
                    {scoringPassed}
                  </div>
                  <div className="text-muted-foreground">Passed</div>
                </div>
                <div className="p-4 rounded-lg border bg-card">
                  <div className="text-2xl font-semibold text-red-600">
                    {scoringFailed}
                  </div>
                  <div className="text-muted-foreground">Failed</div>
                </div>
                <div className="p-4 rounded-lg border bg-card">
                  <div className="text-2xl font-semibold text-muted-foreground">
                    {scoringSkipped}
                  </div>
                  <div className="text-muted-foreground">Skipped</div>
                </div>
                <div className="p-4 rounded-lg border bg-card">
                  <div className="text-2xl font-semibold">{scoringTotal}</div>
                  <div className="text-muted-foreground">Total</div>
                </div>
              </div>

              {/* Show full test breakdown if available */}
              {e2e.total !== scoringTotal && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    View comprehensive E2E test results against all
                    frameworks/configurations
                  </summary>
                  <div className="mt-3 grid gap-4 sm:grid-cols-4">
                    <div className="p-3 rounded-lg border bg-card">
                      <div className="text-xl font-semibold text-green-600">
                        {e2e.passed}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        Passed
                      </div>
                    </div>
                    <div className="p-3 rounded-lg border bg-card">
                      <div className="text-xl font-semibold text-red-600">
                        {e2e.failed}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        Failed
                      </div>
                    </div>
                    <div className="p-3 rounded-lg border bg-card">
                      <div className="text-xl font-semibold text-muted-foreground">
                        {e2e.skipped}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        Skipped
                      </div>
                    </div>
                    <div className="p-3 rounded-lg border bg-card">
                      <div className="text-xl font-semibold">{e2e.total}</div>
                      <div className="text-muted-foreground text-xs">Total</div>
                    </div>
                  </div>
                </details>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">
              No E2E test data is currently available for this world.
            </p>
          )}
        </div>

        {/* Benchmarks Subsection */}
        <div className="space-y-4">
          <h3 className="font-semibold text-lg tracking-tight">Benchmarks</h3>
          {hasBenchmarks ? (
            <>
              <p className="text-sm text-muted-foreground">
                Click on a benchmark to view performance history over the last
                30 commits.
              </p>

              {/* Standard Benchmarks */}
              {standardMetrics.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Benchmark</TableHead>
                      <TableHead className="text-right">
                        <TimeColumnHeader />
                      </TableHead>
                      {hasWorkflowRange && (
                        <>
                          <TableHead className="text-right">Min</TableHead>
                          <TableHead className="text-right">Max</TableHead>
                        </>
                      )}
                      <TableHead className="text-right">Samples</TableHead>
                      <TableHead className="w-[40px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {standardMetrics.map(([name, metric]) => {
                      const isPerfBenchmark = name === PERF_BENCHMARK_NAME;
                      return (
                        <TableRow
                          key={name}
                          className={cn(
                            'cursor-pointer hover:bg-muted/50 transition-colors',
                            isPerfBenchmark && 'bg-muted/30'
                          )}
                          onClick={() => setSelectedMetric(name)}
                        >
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              {isPerfBenchmark && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Timer className="h-4 w-4 text-purple-500 shrink-0" />
                                  </TooltipTrigger>
                                  <TooltipContent
                                    side="top"
                                    className="max-w-[200px]"
                                  >
                                    <p className="text-xs">
                                      Primary performance benchmark (PERF)
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              {name}
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {metric.workflowTime !== undefined
                              ? formatTime(metric.workflowTime)
                              : '—'}
                          </TableCell>
                          {hasWorkflowRange && (
                            <>
                              <TableCell className="text-right font-mono text-muted-foreground">
                                {metric.workflowMin !== undefined
                                  ? formatTime(metric.workflowMin)
                                  : '—'}
                              </TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground">
                                {metric.workflowMax !== undefined
                                  ? formatTime(metric.workflowMax)
                                  : '—'}
                              </TableCell>
                            </>
                          )}
                          <TableCell className="text-right text-muted-foreground">
                            {metric.samples || '—'}
                          </TableCell>
                          <TableCell>
                            <TrendingUp className="h-4 w-4 text-muted-foreground" />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}

              {/* Stream Benchmarks with TTFB and Slurp */}
              {streamMetrics.length > 0 && (
                <>
                  <h4 className="font-medium text-base mt-6">
                    Stream Benchmarks
                  </h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Benchmark</TableHead>
                        <TableHead className="text-right">
                          <TimeColumnHeader />
                        </TableHead>
                        <TableHead className="text-right">
                          <TTFBColumnHeader />
                        </TableHead>
                        <TableHead className="text-right">
                          <SlurpColumnHeader />
                        </TableHead>
                        {hasWorkflowRange && (
                          <>
                            <TableHead className="text-right">Min</TableHead>
                            <TableHead className="text-right">Max</TableHead>
                          </>
                        )}
                        <TableHead className="text-right">Samples</TableHead>
                        <TableHead className="w-[40px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {streamMetrics.map(([name, metric]) => (
                        <TableRow
                          key={name}
                          className="cursor-pointer hover:bg-muted/50 transition-colors"
                          onClick={() => setSelectedMetric(name)}
                        >
                          <TableCell className="font-medium">{name}</TableCell>
                          <TableCell className="text-right font-mono">
                            {metric.workflowTime !== undefined
                              ? formatTime(metric.workflowTime)
                              : '—'}
                          </TableCell>
                          <TableCell className="text-right font-mono text-green-600">
                            {metric.ttfb ? formatTime(metric.ttfb) : '—'}
                          </TableCell>
                          <TableCell className="text-right font-mono text-purple-500">
                            {metric.slurp ? formatTime(metric.slurp) : '—'}
                          </TableCell>
                          {hasWorkflowRange && (
                            <>
                              <TableCell className="text-right font-mono text-muted-foreground">
                                {metric.workflowMin !== undefined
                                  ? formatTime(metric.workflowMin)
                                  : '—'}
                              </TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground">
                                {metric.workflowMax !== undefined
                                  ? formatTime(metric.workflowMax)
                                  : '—'}
                              </TableCell>
                            </>
                          )}
                          <TableCell className="text-right text-muted-foreground">
                            {metric.samples || '—'}
                          </TableCell>
                          <TableCell>
                            <TrendingUp className="h-4 w-4 text-muted-foreground" />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}

              <BenchmarkHistoryChart
                worldId={worldId}
                metricName={selectedMetric ?? ''}
                open={selectedMetric !== null}
                onOpenChange={(open) => !open && setSelectedMetric(null)}
              />
            </>
          ) : (
            <p className="text-muted-foreground">
              No benchmark data is currently available for this world.
            </p>
          )}
        </div>

        {/* Metadata */}
        <div className="text-sm text-muted-foreground border-t pt-4">
          <p>
            Last updated: {new Date(meta.lastUpdated).toLocaleString()}
            {meta.commit && (
              <>
                {' · '}
                Commit:{' '}
                <a
                  href={`https://github.com/vercel/workflow/commit/${meta.commit}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono hover:underline"
                >
                  {meta.commit.slice(0, 7)}
                </a>
              </>
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
