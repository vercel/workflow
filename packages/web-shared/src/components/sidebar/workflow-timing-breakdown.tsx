'use client';

import { Info } from 'lucide-react';
import { formatDurationPrecise } from '../../lib/utils';
import {
  type DerivedWorkflowTimingBreakdown,
  deriveWorkflowTimingBreakdown,
  type WorkflowSpanTiming,
  type WorkflowSpanTimingAttempt,
} from '../../lib/workflow-span-timing';
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

export function WorkflowTimingBreakdown({
  timing,
  resource,
}: {
  timing?: WorkflowSpanTiming;
  resource?: string;
}) {
  if (!timing || (resource !== 'run' && resource !== 'step')) {
    return null;
  }

  const attempts = timing.attempts?.length ? timing.attempts : [timing];
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

  if (breakdowns.length === 0) {
    return null;
  }

  const showAttemptLabels = hasRepeatedAttemptLabel(
    timing,
    breakdowns.map((item) => item.breakdown)
  );
  const summaryDuration =
    breakdowns.length === 1
      ? formatDuration(
          breakdowns[0].breakdown.firstWorkflowRequestStartOffsetMs ??
            breakdowns[0].breakdown.queuedDurationMs
        )
      : null;

  return (
    <DetailCard
      contentClassName="mb-4"
      defaultOpen
      summary={
        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <span className="truncate">Queued</span>
          {summaryDuration ? (
            <span className="shrink-0 text-label-13 font-normal tabular-nums text-gray-900">
              {summaryDuration}
            </span>
          ) : null}
        </span>
      }
    >
      <div className="space-y-3">
        {breakdowns.map(({ attempt, breakdown, index }) => {
          const attemptStartOffset = formatDuration(
            breakdown.firstWorkflowRequestStartOffsetMs
          );
          return (
            <div key={`${attemptLabel(attempt, index)}-${index}`}>
              {showAttemptLabels ? (
                <div className="mb-2 flex items-center justify-between gap-3 text-label-13 text-gray-900">
                  <span className="truncate">
                    {attemptLabel(attempt, index)}
                  </span>
                  {attemptStartOffset ? (
                    <span className="shrink-0 tabular-nums">
                      {attemptStartOffset}
                    </span>
                  ) : null}
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
