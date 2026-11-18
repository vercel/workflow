import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workflow/web-shared';
import {
  formatBillableNote,
  formatDataPurgedNote,
  formatDataWrittenHeading,
  formatEventCountingLines,
  formatLocalDataWrittenNote,
  formatRunUsageSummary,
  formatUsageBytes,
  formatUsageEvents,
  formatUsageFooter,
  formatUsageShare,
  RUN_USAGE_ENTITIES,
  type RunUsage,
  type RunUsageEntity,
  type UsageSpanTreeRow,
  usageBiggestDriver,
  usageSpanLabel,
  usageSpanTree,
  WORKFLOW_PRICING_DOCS_URL,
} from '@workflow/world';
import { AlertCircle, ChevronRight, HelpCircle, RotateCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '~/lib/utils';
import { Skeleton } from './ui/skeleton';

const ENTITY_LABELS: Record<RunUsageEntity, string> = {
  run: 'Run',
  step: 'Steps',
  hook: 'Hooks',
  stream: 'Streams',
};

function RetryBadge({ retries }: { retries: number }) {
  if (retries <= 0) return null;
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full border border-amber-400 bg-amber-100 px-2 py-0.5 text-label-12 text-amber-900">
      {retries === 1 ? '1 retry' : `${retries} retries`}
    </span>
  );
}

function ShareBar({
  share,
  muted = false,
}: {
  share: number;
  muted?: boolean;
}) {
  return (
    <div
      className="h-1.5 w-full min-w-16 rounded-full bg-gray-alpha-200"
      aria-hidden="true"
    >
      <div
        className={cn(
          'h-1.5 rounded-full',
          muted ? 'bg-gray-500' : 'bg-blue-700'
        )}
        style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }}
      />
    </div>
  );
}

/** The standard single tooltip, on whatever it wraps. */
function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p>{text}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Whether the run page shows the header's usage fields and the Usage tab:
 * when the World answered with usage, and while the first read is pending
 * (or failed) on the Local World, which counts it. `null` means the World
 * does not count usage: the page stays as it is without it.
 */
export function usageVisible(
  usage: RunUsage | null | undefined,
  isLocalBackend: boolean
): boolean {
  return usage != null || (usage === undefined && isLocalBackend);
}

/** What the header shows in place of a number the read did not return. */
const UNAVAILABLE = '—';

/**
 * The run header's Events and Storage figures, from the World's count of
 * the whole run (not the events this page has loaded). Storage opens the
 * Usage tab. Until the first read answers they are placeholders; if it
 * failed, they say so (the error is in the tooltip and, in full, on the
 * Usage tab) instead of loading forever.
 */
export function RunUsageHeaderStats({
  usage,
  error,
  onOpenUsage,
}: {
  usage: RunUsage | undefined;
  error: Error | null;
  onOpenUsage: () => void;
}) {
  const failed = !usage && error !== null;
  const failedTitle = failed
    ? `Could not read this run's usage: ${error.message}`
    : undefined;
  const localNote = usage ? formatLocalDataWrittenNote(usage) : null;
  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground">Events</div>
        {usage ? (
          <div className="text-xs" data-testid="run-usage-events">
            {usage.events.toLocaleString('en-US')}
          </div>
        ) : failed ? (
          <div
            className="text-xs text-gray-900"
            data-testid="run-usage-events"
            title={failedTitle}
          >
            {UNAVAILABLE}
          </div>
        ) : (
          <Skeleton className="w-[40px] h-[20px]" />
        )}
      </div>
      <div className="flex flex-col gap-1">
        {localNote ? (
          <Hint text={localNote}>
            <div
              className="text-xs text-muted-foreground cursor-help flex items-center gap-1"
              data-testid="run-usage-storage-label"
            >
              Storage
              <HelpCircle className="w-3 h-3" />
            </div>
          </Hint>
        ) : (
          <div className="text-xs text-muted-foreground">Storage</div>
        )}
        {usage || failed ? (
          <button
            type="button"
            onClick={onOpenUsage}
            className="text-left text-xs underline decoration-dotted underline-offset-2 text-gray-1000 hover:text-blue-900"
            title={
              failedTitle ?? "See where this run's events and data come from"
            }
            data-testid="run-usage-storage"
          >
            {usage ? formatUsageBytes(usage.dataWritten.bytes) : UNAVAILABLE}
          </button>
        ) : (
          <Skeleton className="w-[50px] h-[20px]" />
        )}
      </div>
    </>
  );
}

function CallsTag({ calls }: { calls: number }) {
  if (calls <= 0) return null;
  return <span className="ml-2 text-label-12 text-gray-700">×{calls}</span>;
}

function SpanRow({
  row,
  name,
  muted = false,
  label,
}: {
  row: Pick<UsageSpanTreeRow, 'events' | 'share' | 'retries'>;
  name: ReactNode;
  muted?: boolean;
  label: string;
}) {
  return (
    <tr
      className="border-b border-gray-alpha-200"
      data-testid="run-usage-span"
      data-span={label}
    >
      <td
        className={cn(
          'py-2 pr-4 pl-6',
          muted ? 'text-gray-900' : 'font-mono text-gray-1000'
        )}
      >
        {name}
      </td>
      <td
        className={cn(
          'py-2 pr-4 text-right tabular-nums',
          muted && 'text-gray-900'
        )}
      >
        {row.events.toLocaleString('en-US')}
      </td>
      <td className="hidden py-2 pr-4 sm:table-cell">
        <ShareBar share={row.share} muted={muted} />
      </td>
      <td className="py-2 pr-4 text-right tabular-nums text-gray-900">
        {formatUsageShare(row.share)}
      </td>
      <td className="py-2">
        <RetryBadge retries={row.retries} />
      </td>
    </tr>
  );
}

/**
 * The workflow, its steps (biggest first, the rest folded into "+ N other
 * steps"), then the built-in rows: the run's own events, sleeps and hooks.
 */
function SpansTable({ usage }: { usage: RunUsage }) {
  const [expanded, setExpanded] = useState(false);
  const tree = usageSpanTree(
    usage,
    expanded ? Number.POSITIVE_INFINITY : undefined
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-copy-13">
        <thead>
          <tr className="text-label-12 text-gray-900 border-b border-gray-alpha-400">
            <th className="py-2 pr-4 text-left font-medium">Span</th>
            <th className="py-2 pr-4 text-right font-medium">Events</th>
            <th className="hidden py-2 pr-4 w-1/3 sm:table-cell">
              <span className="sr-only">Share of events</span>
            </th>
            <th className="py-2 pr-4 text-right font-medium">Share</th>
            <th className="py-2 text-left font-medium">
              <span className="sr-only">Retries</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            className="border-b border-gray-alpha-200"
            data-testid="run-usage-span"
            data-span="workflow"
          >
            <td className="py-2 pr-4 font-mono font-medium text-gray-1000">
              {tree.workflow.label}
              <span className="ml-2 rounded border border-gray-alpha-400 px-1.5 py-0.5 font-sans text-label-12 font-normal text-gray-900">
                workflow
              </span>
            </td>
            <td className="py-2 pr-4 text-right tabular-nums font-medium">
              {tree.workflow.events.toLocaleString('en-US')}
            </td>
            <td className="hidden sm:table-cell" />
            <td colSpan={2} />
          </tr>
          {tree.steps.map((row) => (
            <SpanRow
              key={`step:${row.label}`}
              label={row.label}
              row={row}
              name={
                <>
                  {row.label}
                  <CallsTag calls={row.calls} />
                </>
              }
            />
          ))}
          {tree.otherSteps && (
            <tr className="border-b border-gray-alpha-200">
              <td className="py-2 pr-4 pl-6">
                <button
                  type="button"
                  className="text-gray-900 hover:text-gray-1000 underline decoration-dotted underline-offset-2"
                  onClick={() => setExpanded(true)}
                >
                  + {tree.otherSteps.steps} other steps
                </button>
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {tree.otherSteps.events.toLocaleString('en-US')}
              </td>
              <td className="hidden py-2 pr-4 sm:table-cell">
                <ShareBar share={tree.otherSteps.share} />
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-gray-900">
                {formatUsageShare(tree.otherSteps.share)}
              </td>
              <td className="py-2">
                <RetryBadge retries={tree.otherSteps.retries} />
              </td>
            </tr>
          )}
          {tree.showBuiltInLabel && (
            <tr>
              <td
                colSpan={5}
                className="pt-3 pb-1 pl-6 text-label-12 text-gray-700"
                data-testid="run-usage-built-in-label"
              >
                Built-in
              </td>
            </tr>
          )}
          {tree.builtIns.map((row) => (
            <SpanRow
              key={`${row.kind}:${row.label}`}
              label={row.label}
              row={row}
              muted
              name={
                row.note ? (
                  <Hint text={row.note}>
                    <span className="cursor-help underline decoration-dotted underline-offset-2">
                      {row.label}
                    </span>
                  </Hint>
                ) : (
                  <>
                    {row.label}
                    <CallsTag calls={row.calls} />
                  </>
                )
              }
            />
          ))}
        </tbody>
      </table>
    </div>
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

/** The Usage tab: where a run's events and data come from. */
export function RunUsagePanel({
  usage,
  error,
  onRetry,
  retrying = false,
}: {
  usage: RunUsage | undefined;
  error: Error | null;
  /** Reads the usage again: a finished run does not poll. */
  onRetry?: () => void;
  retrying?: boolean;
}) {
  if (!usage) {
    if (error) {
      return (
        <div className="flex flex-col items-start gap-3 p-6">
          <div className="flex items-center gap-2 text-copy-13 text-red-800">
            <AlertCircle className="h-4 w-4" />
            Could not read this run's usage: {error.message}
          </div>
          {onRetry && (
            <Button
              variant="secondary"
              size="small"
              onClick={onRetry}
              disabled={retrying}
            >
              <RotateCw className="h-4 w-4 mr-2" />
              {retrying ? 'Trying again…' : 'Try again'}
            </Button>
          )}
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

  const driver = usageBiggestDriver(usage);
  const billableNote = formatBillableNote(usage);
  const purgedNote = formatDataPurgedNote(usage);
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl space-y-8 py-6">
        <section className="space-y-1">
          <p
            className="text-heading-20 text-gray-1000"
            data-testid="run-usage-summary"
          >
            {formatRunUsageSummary(usage)}
          </p>
          {billableNote && (
            <p
              className="text-copy-13 text-gray-900"
              data-testid="run-usage-billable-note"
            >
              {billableNote}
            </p>
          )}
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

        {usage.eventsBySpan.length > 0 && (
          <Section title="Where the events come from">
            {driver && (
              <div
                className="rounded-md border border-blue-400 bg-blue-100 px-4 py-3 text-copy-13 text-blue-900"
                data-testid="run-usage-driver"
              >
                <span className="font-mono font-medium">
                  {usageSpanLabel(driver)}
                </span>{' '}
                drives {formatUsageShare(driver.share)} of this run's events (
                {formatUsageEvents(driver.events)}
                {driver.retries > 0 &&
                  `, ${driver.retries === 1 ? '1 retry' : `${driver.retries} retries`}`}
                ).
              </div>
            )}
            <SpansTable usage={usage} />
          </Section>
        )}

        <details className="group rounded-md border border-gray-alpha-400">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-label-14 text-gray-1000">
            <ChevronRight className="h-4 w-4 text-gray-700 transition-transform group-open:rotate-90" />
            How events are counted
          </summary>
          <ul
            className="list-disc space-y-1 px-10 pb-4 text-copy-13 text-gray-900"
            data-testid="run-usage-counting"
          >
            {formatEventCountingLines(usage).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>

        <Section title="Storage">
          {purgedNote && (
            <p
              className="text-copy-13 text-gray-900"
              data-testid="run-usage-purged-note"
            >
              {purgedNote}
            </p>
          )}
          <table className="w-full text-copy-13">
            <thead>
              <tr className="text-label-12 text-gray-900 border-b border-gray-alpha-400">
                <th
                  className="py-2 pr-4 text-left font-medium"
                  data-testid="run-usage-data-heading"
                >
                  {formatDataWrittenHeading(usage)}
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
          <span data-testid="run-usage-footer">
            {usage.billed ? (
              <span className="font-medium text-gray-1000">
                {formatUsageFooter(usage)}
              </span>
            ) : (
              formatUsageFooter(usage)
            )}
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
