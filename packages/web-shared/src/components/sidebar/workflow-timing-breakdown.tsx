'use client';

import { Info } from 'lucide-react';
import { formatDurationPrecise } from '../../lib/utils';
import {
  type DerivedWorkflowTimingBreakdown,
  deriveWorkflowTimingBreakdown,
  type WorkflowSpanTiming,
  type WorkflowSpanTimingAttempt,
} from '../../lib/workflow-span-timing';
import { Skeleton } from '../ui/skeleton';
import { DetailCard } from './detail-card';

const TIMING_LABELS = {
  coldStart: {
    label: 'Cold start',
    description: 'Time Fluid spent starting a cold VM for this invocation.',
  },
  moduleInit: {
    label: 'Module Init',
    description:
      'Time before the first Workflow API request that was not cold start.',
  },
  workflowOverhead: {
    label: 'Workflow Overhead',
    description: 'Duration of the first Workflow API request.',
  },
};

function formatDuration(value: number | undefined): string | null {
  return value === undefined ? null : formatDurationPrecise(value);
}

function TimingRow({
  label,
  description,
  value,
  fallback = 'None',
}: {
  label: string;
  description: string;
  value: number | undefined;
  fallback?: string;
}) {
  const formatted = formatDuration(value);

  return (
    <div className="flex min-h-8 items-center justify-between gap-4 border-t border-gray-alpha-400 first:border-t-0">
      <span
        className="inline-flex min-w-0 items-center gap-1.5 text-label-13 text-gray-900"
        title={description}
      >
        <span className="truncate">{label}</span>
        <Info aria-hidden className="h-3 w-3 shrink-0 text-gray-700" />
      </span>
      <span
        className={`shrink-0 text-label-13 font-medium tabular-nums ${
          formatted ? 'text-gray-1000' : 'text-gray-900'
        }`}
      >
        {formatted ?? fallback}
      </span>
    </div>
  );
}

function hasRepeatedAttemptLabel(
  timing: WorkflowSpanTiming,
  breakdowns: DerivedWorkflowTimingBreakdown[]
) {
  return Boolean(timing.attempts?.length) && breakdowns.length > 1;
}

function attemptLabel(
  attempt: WorkflowSpanTimingAttempt | WorkflowSpanTiming,
  index: number
) {
  if ('label' in attempt && attempt.label) {
    return attempt.label;
  }
  if ('attempt' in attempt && typeof attempt.attempt === 'number') {
    return `Attempt ${attempt.attempt}`;
  }
  return `Attempt ${index + 1}`;
}

function TimingRows({
  breakdown,
}: {
  breakdown: DerivedWorkflowTimingBreakdown;
}) {
  return (
    <div className="rounded-md border border-gray-alpha-400 bg-background-200 px-3 py-1">
      <TimingRow
        description={TIMING_LABELS.coldStart.description}
        label={TIMING_LABELS.coldStart.label}
        value={breakdown.coldStartDurationMs}
      />
      <TimingRow
        description={TIMING_LABELS.moduleInit.description}
        label={TIMING_LABELS.moduleInit.label}
        value={breakdown.moduleInitDurationMs}
      />
      <TimingRow
        description={TIMING_LABELS.workflowOverhead.description}
        label={TIMING_LABELS.workflowOverhead.label}
        value={breakdown.workflowOverheadDurationMs}
      />
    </div>
  );
}

function TimingRowsSkeleton() {
  return (
    <div className="rounded-md border border-gray-alpha-400 bg-background-200 px-3 py-1">
      {[
        TIMING_LABELS.coldStart.label,
        TIMING_LABELS.moduleInit.label,
        TIMING_LABELS.workflowOverhead.label,
      ].map((label) => (
        <div
          className="flex min-h-8 items-center justify-between gap-4 border-t border-gray-alpha-400 first:border-t-0"
          key={label}
        >
          <span className="text-label-13 text-gray-900">{label}</span>
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

export function WorkflowTimingBreakdown({
  timing,
  resource,
}: {
  timing?: WorkflowSpanTiming;
  resource?: string;
}) {
  if (resource !== 'run' && resource !== 'step') {
    return null;
  }

  const isLoading = Boolean(timing?.isLoading);

  if (!timing && !isLoading) {
    return null;
  }

  const attempts = timing?.attempts?.length
    ? timing.attempts
    : timing
      ? [timing]
      : [];
  const breakdowns = attempts
    .map((attempt, index) => ({
      attempt,
      index,
      breakdown: deriveWorkflowTimingBreakdown(attempt),
    }))
    .filter(
      (
        item
      ): item is {
        attempt: WorkflowSpanTimingAttempt | WorkflowSpanTiming;
        index: number;
        breakdown: DerivedWorkflowTimingBreakdown;
      } => item.breakdown !== null
    );

  if (breakdowns.length === 0 && !isLoading) {
    return null;
  }

  const showAttemptLabels = timing
    ? hasRepeatedAttemptLabel(
        timing,
        breakdowns.map((item) => item.breakdown)
      )
    : false;

  return (
    <DetailCard
      contentClassName="mb-4"
      summary={<span className="min-w-0 flex-1 truncate">Queued</span>}
    >
      <div className="space-y-3">
        {isLoading ? <TimingRowsSkeleton /> : null}
        {!isLoading &&
          breakdowns.map(({ attempt, breakdown, index }) => {
            return (
              <div key={`${attemptLabel(attempt, index)}-${index}`}>
                {showAttemptLabels ? (
                  <div className="mb-2 text-label-13 text-gray-900">
                    {attemptLabel(attempt, index)}
                  </div>
                ) : null}
                <TimingRows breakdown={breakdown} />
              </div>
            );
          })}
      </div>
    </DetailCard>
  );
}
