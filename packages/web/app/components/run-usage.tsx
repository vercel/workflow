import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import {
  collapseUsageSpans,
  EVENTS_PER_RETRY,
  EVENTS_PER_STEP,
  formatRunUsageSummary,
  formatUsageBytes,
  formatUsageEvents,
  formatUsageShare,
  RUN_USAGE_ENTITIES,
  type RunUsage,
  type RunUsageEntity,
  type RunUsageSpan,
  WORKFLOW_PRICING_DOCS_URL,
} from '@workflow/world';
import { AlertCircle, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Skeleton } from './ui/skeleton';

/** A span's name as the trace shows it: the function's short name. */
export function usageSpanLabel(span: Pick<RunUsageSpan, 'kind' | 'name'>) {
  if (span.kind === 'step') {
    return parseStepName(span.name)?.shortName || span.name;
  }
  if (span.kind === 'run') {
    return parseWorkflowName(span.name)?.shortName || span.name;
  }
  return span.name;
}

const ENTITY_LABELS: Record<RunUsageEntity, string> = {
  run: 'Run',
  step: 'Steps',
  hook: 'Hooks',
  stream: 'Streams',
};

function RetryBadge({ retries }: { retries: number }) {
  if (retries <= 0) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-amber-400 bg-amber-100 px-2 py-0.5 text-label-12 text-amber-900">
      {retries === 1 ? '1 retry' : `${retries} retries`}
    </span>
  );
}

function ShareBar({ share }: { share: number }) {
  return (
    <div
      className="h-1.5 w-full min-w-16 rounded-full bg-gray-alpha-200"
      aria-hidden="true"
    >
      <div
        className="h-1.5 rounded-full bg-blue-700"
        style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }}
      />
    </div>
  );
}

/**
 * The run header's Events and Storage figures, from the World's count of
 * the whole run (not the events this page has loaded). Storage opens the
 * Usage tab.
 */
export function RunUsageHeaderStats({
  usage,
  onOpenUsage,
}: {
  usage: RunUsage | undefined;
  onOpenUsage: () => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground">Events</div>
        {usage ? (
          <div className="text-xs" data-testid="run-usage-events">
            {usage.events.toLocaleString('en-US')}
          </div>
        ) : (
          <Skeleton className="w-[40px] h-[20px]" />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground">Storage</div>
        {usage ? (
          <button
            type="button"
            onClick={onOpenUsage}
            className="text-left text-xs underline decoration-dotted underline-offset-2 text-gray-1000 hover:text-blue-900"
            title="See where this run's events and data come from"
          >
            {formatUsageBytes(usage.dataWritten.bytes)}
          </button>
        ) : (
          <Skeleton className="w-[50px] h-[20px]" />
        )}
      </div>
    </>
  );
}

function SpansTable({ usage }: { usage: RunUsage }) {
  const [expanded, setExpanded] = useState(false);
  const { shown, other } = collapseUsageSpans(usage.eventsBySpan);
  const rows = expanded ? usage.eventsBySpan : shown;
  return (
    <table className="w-full text-copy-13">
      <thead>
        <tr className="text-label-12 text-gray-900 border-b border-gray-alpha-400">
          <th className="py-2 pr-4 text-left font-medium">Span</th>
          <th className="py-2 pr-4 text-right font-medium">Events</th>
          <th className="py-2 pr-4 w-1/3">
            <span className="sr-only">Share of events</span>
          </th>
          <th className="py-2 pr-4 text-right font-medium">Share</th>
          <th className="py-2 text-left font-medium">
            <span className="sr-only">Retries</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((span) => (
          <tr
            key={`${span.kind}:${span.name}`}
            className="border-b border-gray-alpha-200"
            data-testid="run-usage-span"
          >
            <td
              className="py-2 pr-4 font-mono text-gray-1000"
              title={span.name}
            >
              {usageSpanLabel(span)}
            </td>
            <td className="py-2 pr-4 text-right tabular-nums">
              {span.events.toLocaleString('en-US')}
            </td>
            <td className="py-2 pr-4">
              <ShareBar share={span.share} />
            </td>
            <td className="py-2 pr-4 text-right tabular-nums text-gray-900">
              {formatUsageShare(span.share)}
            </td>
            <td className="py-2">
              <RetryBadge retries={span.retries} />
            </td>
          </tr>
        ))}
        {other && !expanded && (
          <tr className="border-b border-gray-alpha-200">
            <td className="py-2 pr-4">
              <button
                type="button"
                className="text-gray-900 hover:text-gray-1000 underline decoration-dotted underline-offset-2"
                onClick={() => setExpanded(true)}
              >
                {other.spans} other spans
              </button>
            </td>
            <td className="py-2 pr-4 text-right tabular-nums">
              {other.events.toLocaleString('en-US')}
            </td>
            <td className="py-2 pr-4">
              <ShareBar share={other.share} />
            </td>
            <td className="py-2 pr-4 text-right tabular-nums text-gray-900">
              {formatUsageShare(other.share)}
            </td>
            <td className="py-2">
              <RetryBadge retries={other.retries} />
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-heading-16 text-gray-1000">{title}</h3>
      {children}
    </section>
  );
}

/** The Usage tab: where a run's billable events and data come from. */
export function RunUsagePanel({
  usage,
  error,
}: {
  usage: RunUsage | undefined;
  error: Error | null;
}) {
  if (!usage) {
    if (error) {
      return (
        <div className="flex items-center gap-2 p-6 text-copy-13 text-red-800">
          <AlertCircle className="h-4 w-4" />
          Could not read this run's usage: {error.message}
        </div>
      );
    }
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-6 w-80" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const top = usage.eventsBySpan[0];
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-8 py-6">
        <section className="space-y-1">
          <p
            className="text-heading-20 text-gray-1000"
            data-testid="run-usage-summary"
          >
            {formatRunUsageSummary(usage)}
          </p>
          {usage.inProgress && (
            <p className="text-copy-13 text-gray-900">
              This run has not finished; its usage can still grow.
            </p>
          )}
          {error && (
            <p className="text-copy-13 text-amber-800">
              Showing the last numbers read; refreshing failed: {error.message}
            </p>
          )}
        </section>

        {top && (
          <Section title="Where the events come from">
            <div
              className="rounded-md border border-blue-400 bg-blue-100 px-4 py-3 text-copy-13 text-blue-900"
              data-testid="run-usage-driver"
            >
              <span className="font-mono font-medium">
                {usageSpanLabel(top)}
              </span>{' '}
              drives {formatUsageShare(top.share)} of this run's events (
              {formatUsageEvents(top.events)}
              {top.retries > 0 &&
                `, ${top.retries === 1 ? '1 retry' : `${top.retries} retries`}`}
              ).
            </div>
            <SpansTable usage={usage} />
          </Section>
        )}

        <details className="group rounded-md border border-gray-alpha-400">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-label-14 text-gray-1000">
            <ChevronRight className="h-4 w-4 text-gray-700 transition-transform group-open:rotate-90" />
            How events are counted
          </summary>
          <ul className="list-disc space-y-1 px-10 pb-4 text-copy-13 text-gray-900">
            <li>
              Each step writes {EVENTS_PER_STEP} events: created, started and
              completed.
            </li>
            <li>
              Each retry adds {EVENTS_PER_RETRY}: a retry marker, and the step
              starting again.
            </li>
            <li>
              The run writes its own: created, started, and completed or failed.
              A sleep writes 2, a hook at least 2.
            </li>
            <li>
              Every event in the log is billable today. The count covers the
              whole run, not only the events loaded on this page.
            </li>
          </ul>
        </details>

        <Section title="Storage">
          <table className="w-full text-copy-13">
            <thead>
              <tr className="text-label-12 text-gray-900 border-b border-gray-alpha-400">
                <th className="py-2 pr-4 text-left font-medium">
                  Data written
                </th>
                <th className="py-2 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {RUN_USAGE_ENTITIES.map((entity) => (
                <tr
                  key={entity}
                  className="border-b border-gray-alpha-200"
                  data-testid="run-usage-entity"
                >
                  <td className="py-2 pr-4 text-gray-1000">
                    {ENTITY_LABELS[entity]}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatUsageBytes(usage.dataWritten.byEntity[entity])}
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-2 pr-4 text-gray-1000">Total</td>
                <td
                  className="py-2 text-right tabular-nums"
                  data-testid="run-usage-total"
                >
                  {formatUsageBytes(usage.dataWritten.bytes)}
                </td>
              </tr>
            </tbody>
          </table>
          {usage.dataRetained && (
            <div
              className="rounded-md border border-gray-alpha-400 px-4 py-3"
              data-testid="run-usage-retained"
            >
              <div className="text-label-12 text-gray-900">Data retained</div>
              <div className="text-copy-14 text-gray-1000">
                {formatUsageBytes(usage.dataRetained.byteMonths)}-months
              </div>
              <div className="text-copy-13 text-gray-900">
                Data written × {usage.dataRetained.retentionMonths} month
                retention
              </div>
            </div>
          )}
        </Section>

        <footer className="flex items-center justify-between gap-4 border-t border-gray-alpha-400 pt-4 text-copy-13 text-gray-900">
          <span>
            <span className="font-medium text-gray-1000">
              Not your final bill.
            </span>{' '}
            Counted from this run's log in your local data directory.
          </span>
          <a
            href={WORKFLOW_PRICING_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-blue-900 hover:underline"
          >
            See pricing →
          </a>
        </footer>
      </div>
    </div>
  );
}
