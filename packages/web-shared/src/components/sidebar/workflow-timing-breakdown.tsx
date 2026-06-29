'use client';

import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { formatDurationPrecise } from '../../lib/utils';
import {
  type DerivedWorkflowTimingBreakdown,
  deriveWorkflowTimingBreakdown,
  type WorkflowSpanTiming,
  type WorkflowSpanTimingAttempt,
} from '../../lib/workflow-span-timing';
import {
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { Skeleton } from '../ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const TIMING_LABELS = {
  coldStart: {
    label: 'Cold start',
    description: 'Fluid Compute function cold start time.',
  },
  moduleInit: {
    label: 'Module Init',
    description:
      'Time it took to load the function module before the first Workflow request was made.',
  },
  workflowOverhead: {
    label: 'Workflow Overhead',
    description: 'Duration of the first Workflow API request.',
  },
};

const MODULE_INIT_WARNING_THRESHOLD_MS = 50;
const MODULE_INIT_WARNING_DESCRIPTION =
  'Module loading took over 50ms. Move expensive imports or startup work out of module scope, or lazy-load them before making Workflow requests.';
const timingRowClassName =
  'px-1.5 hover:bg-gray-100 flex justify-between gap-3 -mx-1.5 py-0.5 rounded items-center';

function formatDuration(value: number | undefined): string | null {
  return value === undefined ? null : formatDurationPrecise(value);
}

function TimingInfoTooltip({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`${label} timing info`}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-gray-700 transition-colors hover:text-gray-1000 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-800"
          type="button"
        >
          <Info aria-hidden className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

function ModuleInitWarningBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label="High module init timing"
          className="shrink-0 cursor-help rounded-sm border px-1.5 py-0.5 text-[10px] font-medium leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-900"
          style={{
            borderColor: 'var(--ds-red-400)',
            backgroundColor: 'var(--ds-red-100)',
            color: 'var(--ds-red-900)',
          }}
          type="button"
        >
          High
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">
        {MODULE_INIT_WARNING_DESCRIPTION}
      </TooltipContent>
    </Tooltip>
  );
}

function TimingRow({
  label,
  description,
  value,
  badge,
  fallback = 'None',
}: {
  label: string;
  description: string;
  value: number | undefined;
  badge?: ReactNode;
  fallback?: string;
}) {
  const formatted = formatDuration(value);

  return (
    <div className={timingRowClassName}>
      <span className="flex min-w-0 items-center gap-1.5 truncate text-label-13 text-gray-900">
        <span className="truncate">{label}</span>
        <TimingInfoTooltip description={description} label={label} />
        {badge}
      </span>
      <span
        className={cn(
          'max-w-[60%] shrink-0 truncate text-right text-copy-13 tabular-nums',
          formatted ? 'text-gray-1000' : 'text-gray-900'
        )}
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
    <div className="flex flex-col">
      <TimingRow
        description={TIMING_LABELS.coldStart.description}
        label={TIMING_LABELS.coldStart.label}
        value={breakdown.coldStartDurationMs}
      />
      <TimingRow
        badge={
          breakdown.moduleInitDurationMs !== undefined &&
          breakdown.moduleInitDurationMs > MODULE_INIT_WARNING_THRESHOLD_MS ? (
            <ModuleInitWarningBadge />
          ) : undefined
        }
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
    <div className="flex flex-col">
      {[
        TIMING_LABELS.coldStart.label,
        TIMING_LABELS.moduleInit.label,
        TIMING_LABELS.workflowOverhead.label,
      ].map((label) => (
        <div className={timingRowClassName} key={label}>
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
    <CollapsibleRoot>
      <CollapsibleTrigger>Queued</CollapsibleTrigger>
      <CollapsibleContent className="mb-4">
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
      </CollapsibleContent>
    </CollapsibleRoot>
  );
}
