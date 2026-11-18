import {
  Button,
  cn,
  ResourceIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workflow/web-shared';
import {
  formatCount,
  formatDataPurgedNote,
  formatDataWrittenHeading,
  formatLocalDataWrittenNote,
  formatOtherSteps,
  formatUsageBytes,
  formatUsageFooter,
  formatUsageShare,
  RUN_USAGE_ENTITIES,
  RUN_USAGE_RUN_EVENT_TYPES,
  type RunUsage,
  type RunUsageEntity,
  type RunUsageSpanKind,
  type UsageSpanTreeRow,
  usageSpanTree,
  WORKFLOW_PRICING_DOCS_URL,
} from '@workflow/world';
import { AlertCircle, HelpCircle, RotateCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { Skeleton } from './ui/skeleton';

/** The docs section that explains how a run's usage is counted. */
export const RUN_USAGE_DOCS_URL =
  'https://workflow-sdk.dev/docs/observability#run-usage';

/** The run's Usage page. */
export function runUsagePath(runId: string): string {
  return `/run/${encodeURIComponent(runId)}/usage`;
}

/** The run's page (Trace, Events, Streams). */
export function runPath(runId: string): string {
  return `/run/${encodeURIComponent(runId)}`;
}

const ENTITY_LABELS: Record<RunUsageEntity, string> = {
  run: 'Run',
  step: 'Steps',
  hook: 'Hooks',
  stream: 'Streams',
};

/**
 * The trace's icon for each kind of row, mapped the way the Events tab maps
 * event types: `run_*` and `attr_set` are the run's own (workflow icon),
 * sleeps are `sleep`, unknown event types get the generic icon.
 */
const ROW_RESOURCE: Record<RunUsageSpanKind, string> = {
  run: 'run',
  attributes: 'run',
  step: 'step',
  wait: 'sleep',
  hook: 'hook',
  other: 'event',
};

const ROW_TYPE_NAME: Record<RunUsageSpanKind, string> = {
  run: 'Workflow',
  attributes: 'Workflow',
  step: 'Step',
  wait: 'Sleep',
  hook: 'Hook',
  other: 'Event',
};

/** Rows whose `calls` is a count worth showing: step, sleep and hook calls. */
const SHOWS_CALLS: ReadonlySet<RunUsageSpanKind> = new Set([
  'step',
  'wait',
  'hook',
]);

/** The trace's type icon, with the type named for screen readers. */
function RowIcon({ kind }: { kind: RunUsageSpanKind }) {
  return (
    <>
      <ResourceIcon resource={ROW_RESOURCE[kind]} />
      <span className="sr-only">{ROW_TYPE_NAME[kind]}:</span>
    </>
  );
}

function RetryBadge({ retries }: { retries: number }) {
  if (retries <= 0) return null;
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-full border border-amber-400 bg-amber-100 px-2 text-label-12 leading-4 text-amber-900"
      data-testid="run-usage-retries"
    >
      {formatCount(retries, 'retry', 'retries')}
    </span>
  );
}

function CallsCount({ calls }: { calls: number }) {
  if (calls <= 0) return null;
  return (
    <span
      className="whitespace-nowrap font-sans text-label-12 text-gray-700"
      data-testid="run-usage-calls"
    >
      {formatCount(calls, 'call', 'calls')}
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

/**
 * Whether the run page shows the header's usage fields: when the World
 * answered with usage, and while the first read is pending (or failed) on
 * the Local World, which counts it. `null` means the World does not count
 * usage: the page stays as it is without it.
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
 * `Data written (local)` on a run that is not billed. Before the first read
 * answers, the backend decides: only the Local World shows the field then.
 */
export function dataWrittenLabel(
  usage: RunUsage | undefined,
  isLocalBackend: boolean
): string {
  if (usage) return formatDataWrittenHeading(usage);
  return isLocalBackend ? 'Data written (local)' : 'Data written';
}

const failedMessage = (error: Error) =>
  `Failed to read this run’s usage: ${error.message}`;

/**
 * A header figure: a link to the Usage page, or plain text on the Usage page
 * itself, so the page does not link to itself.
 */
function HeaderFigure({
  to,
  onUsagePage,
  label,
  title,
  testId,
  children,
}: {
  to: string;
  onUsagePage: boolean;
  label: string;
  title?: string;
  testId: string;
  children: ReactNode;
}) {
  if (onUsagePage) {
    return (
      <div className="text-xs" data-testid={testId} title={title}>
        {children}
      </div>
    );
  }
  return (
    <Link
      to={to}
      className="-my-1 inline-block min-w-6 rounded-sm py-1 text-left text-xs underline decoration-dotted underline-offset-2 text-gray-1000 hover:text-blue-900 focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
      aria-label={label}
      title={title}
      data-testid={testId}
    >
      {children}
    </Link>
  );
}

/**
 * The run header's Events and Data written figures, from the World's count
 * of the whole run (not the events this page has loaded). Both open the
 * run's Usage page. Until the first read answers they are placeholders; if
 * it failed, they say so (the error is in the tooltip and, in full, on the
 * Usage page) instead of loading forever.
 */
export function RunUsageHeaderStats({
  runId,
  usage,
  error,
  isLocalBackend,
  onUsagePage = false,
}: {
  runId: string;
  usage: RunUsage | undefined;
  error: Error | null;
  isLocalBackend: boolean;
  /** On the Usage page the figures are text, not links to it. */
  onUsagePage?: boolean;
}) {
  const failed = !usage && error !== null;
  const failedTitle = failed ? failedMessage(error) : undefined;
  const localNote = usage ? formatLocalDataWrittenNote(usage) : null;
  const to = runUsagePath(runId);
  const label = dataWrittenLabel(usage, isLocalBackend);
  const events = usage ? usage.events.toLocaleString('en-US') : UNAVAILABLE;
  const bytes = usage ? formatUsageBytes(usage.dataWritten.bytes) : UNAVAILABLE;
  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground">Events</div>
        {usage || failed ? (
          <div className="flex items-baseline gap-1.5">
            <HeaderFigure
              to={to}
              onUsagePage={onUsagePage}
              label={
                usage
                  ? `${formatCount(usage.events, 'event', 'events')}, open usage`
                  : 'Events unavailable, open usage'
              }
              title={failedTitle}
              testId="run-usage-events"
            >
              {events}
            </HeaderFigure>
            {usage && usage.retries.count > 0 && (
              <span
                className="text-xs text-gray-900"
                data-testid="run-usage-header-retries"
              >
                {formatCount(usage.retries.count, 'retry', 'retries')}
              </span>
            )}
          </div>
        ) : (
          <Skeleton className="w-[40px] h-[20px]" />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <div
          className="text-xs text-muted-foreground flex items-center gap-1"
          data-testid="run-usage-data-label"
        >
          {label}
          {localNote && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="-m-1.5 inline-flex cursor-help rounded-sm p-1.5 text-muted-foreground hover:text-gray-1000 focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
                  aria-label={`About ${label}`}
                  data-testid="run-usage-data-help"
                >
                  <HelpCircle className="w-3 h-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p>{localNote}</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {usage || failed ? (
          <HeaderFigure
            to={to}
            onUsagePage={onUsagePage}
            label={
              usage
                ? `${bytes} ${label.toLowerCase()}, open usage`
                : `${label} unavailable, open usage`
            }
            title={failedTitle}
            testId="run-usage-data-written"
          >
            {bytes}
          </HeaderFigure>
        ) : (
          <Skeleton className="w-[50px] h-[20px]" />
        )}
      </div>
    </>
  );
}

/** `1 created, 1 started, 1 completed`: the run's own events, by type. */
export function formatRunEventTypes(usage: RunUsage): string | null {
  const { events, byType } = usage.runEvents;
  if (events <= 0) return null;
  const parts = RUN_USAGE_RUN_EVENT_TYPES.flatMap((type) =>
    byType[type] > 0 ? [`${byType[type].toLocaleString('en-US')} ${type}`] : []
  );
  const known = RUN_USAGE_RUN_EVENT_TYPES.reduce((n, t) => n + byType[t], 0);
  if (events > known) {
    parts.push(`${(events - known).toLocaleString('en-US')} other`);
  }
  return parts.join(', ');
}

const CELL = 'py-2 pr-4';

function SpanRow({
  kind,
  label,
  detail,
  row,
  indent = true,
  muted = false,
}: {
  kind: RunUsageSpanKind;
  label: ReactNode;
  /** Secondary text after the label: calls, or the run's event types. */
  detail?: ReactNode;
  row: Pick<UsageSpanTreeRow, 'events' | 'share' | 'retries'>;
  indent?: boolean;
  muted?: boolean;
}) {
  return (
    <tr
      className="border-b border-gray-alpha-200"
      data-testid="run-usage-span"
      data-kind={kind}
    >
      <td className={cn(CELL, indent && 'pl-6')}>
        <div className="flex min-w-0 items-start gap-2">
          <span className="flex h-[18px] shrink-0 items-center">
            <RowIcon kind={kind} />
          </span>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                'min-w-0 [overflow-wrap:anywhere]',
                muted ? 'text-gray-900' : 'font-mono text-gray-1000'
              )}
              data-testid="run-usage-span-label"
            >
              {label}
            </span>
            {detail}
          </span>
        </div>
      </td>
      <td
        className={cn(
          CELL,
          'text-right tabular-nums',
          muted && 'text-gray-900'
        )}
      >
        {row.events.toLocaleString('en-US')}
      </td>
      <td className={cn(CELL, 'hidden sm:table-cell')}>
        <ShareBar share={row.share} muted={muted} />
      </td>
      <td className={cn(CELL, 'text-right tabular-nums text-gray-900')}>
        {formatUsageShare(row.share)}
      </td>
      <td className="py-2">
        <RetryBadge retries={row.retries} />
      </td>
    </tr>
  );
}

const TABLE_HEAD_ROW =
  'text-label-12 text-gray-900 border-b border-gray-alpha-400';

/**
 * The workflow, its steps (biggest first, the rest folded into "+ N other
 * steps"), then the built-in rows: the run's own events, attributes,
 * sleeps, hooks and unknown events.
 */
function SpansTable({ usage }: { usage: RunUsage }) {
  const [expanded, setExpanded] = useState(false);
  const tree = usageSpanTree(
    usage,
    expanded ? Number.POSITIVE_INFINITY : undefined
  );
  const runEventTypes = formatRunEventTypes(usage);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-copy-13" data-testid="run-usage-spans">
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            <th className={cn(CELL, 'text-left font-medium')}>Span</th>
            <th className={cn(CELL, 'text-right font-medium')}>Events</th>
            <th className={cn(CELL, 'hidden w-1/4 sm:table-cell')}>
              <span className="sr-only">Share of Events</span>
            </th>
            <th className={cn(CELL, 'text-right font-medium')}>Share</th>
            <th className="py-2 text-left font-medium">
              <span className="sr-only">Retries</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            className="border-b border-gray-alpha-200"
            data-testid="run-usage-span"
            data-kind="workflow"
          >
            <td className={CELL}>
              <div className="flex min-w-0 items-center gap-2">
                <RowIcon kind="run" />
                <span
                  className="min-w-0 font-mono font-medium text-gray-1000 [overflow-wrap:anywhere]"
                  data-testid="run-usage-span-label"
                >
                  {tree.workflow.label}
                </span>
              </div>
            </td>
            <td className={cn(CELL, 'text-right tabular-nums font-medium')}>
              {tree.workflow.events.toLocaleString('en-US')}
            </td>
            <td className="hidden sm:table-cell" />
            <td colSpan={2} />
          </tr>
          {tree.steps.map((row) => (
            <SpanRow
              key={`step:${row.label}`}
              kind="step"
              label={row.label}
              detail={<CallsCount calls={row.calls} />}
              row={row}
            />
          ))}
          {tree.otherSteps && (
            <tr className="border-b border-gray-alpha-200">
              <td className={cn(CELL, 'pl-6')}>
                <button
                  type="button"
                  className="-my-[3px] rounded-sm py-[3px] text-gray-900 hover:text-gray-1000 underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
                  onClick={() => setExpanded(true)}
                >
                  {formatOtherSteps(tree.otherSteps.steps)}
                </button>
              </td>
              <td className={cn(CELL, 'text-right tabular-nums')}>
                {tree.otherSteps.events.toLocaleString('en-US')}
              </td>
              <td className={cn(CELL, 'hidden sm:table-cell')}>
                <ShareBar share={tree.otherSteps.share} />
              </td>
              <td className={cn(CELL, 'text-right tabular-nums text-gray-900')}>
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
              kind={row.kind}
              label={row.label}
              row={row}
              muted
              detail={
                row.kind === 'run' && runEventTypes ? (
                  <span
                    className="font-sans text-label-12 text-gray-700"
                    data-testid="run-usage-run-event-types"
                  >
                    {runEventTypes}
                  </span>
                ) : SHOWS_CALLS.has(row.kind) ? (
                  <CallsCount calls={row.calls} />
                ) : undefined
              }
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The run's data written, by entity, with the total. */
function DataWrittenTable({ usage }: { usage: RunUsage }) {
  const purgedNote = formatDataPurgedNote(usage);
  return (
    <div className="space-y-3">
      <table className="w-full text-copy-13" data-testid="run-usage-data">
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            <th
              className={cn(CELL, 'text-left font-medium')}
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
              <td className={cn(CELL, 'text-gray-1000')}>
                {ENTITY_LABELS[entity]}
              </td>
              <td className="py-2 text-right tabular-nums">
                {formatUsageBytes(usage.dataWritten.byEntity[entity])}
              </td>
            </tr>
          ))}
          <tr className="font-medium">
            <td className={cn(CELL, 'text-gray-1000')}>Total</td>
            <td
              className="py-2 text-right tabular-nums"
              data-testid="run-usage-total"
            >
              {formatUsageBytes(usage.dataWritten.bytes)}
            </td>
          </tr>
        </tbody>
      </table>
      {purgedNote && (
        <p
          className="text-copy-13 text-gray-900"
          data-testid="run-usage-purged-note"
        >
          {purgedNote}
        </p>
      )}
      {usage.dataRetained && (
        <div data-testid="run-usage-retained">
          <div className="text-label-12 text-gray-900">Data retained</div>
          <div className="text-copy-14 text-gray-1000">
            {formatUsageBytes(usage.dataRetained.byteMonths)}-months
          </div>
          <div className="text-copy-13 text-gray-900">
            Data written × {usage.dataRetained.retentionMonths} month retention
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The two tables: side by side from the `lg` breakpoint (1024px), the spans
 * wider; stacked below it.
 */
export const USAGE_TABLES_LAYOUT =
  'grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-10';

function UsageTables({ spans, data }: { spans: ReactNode; data: ReactNode }) {
  return (
    <div className={USAGE_TABLES_LAYOUT} data-testid="run-usage-tables">
      <section aria-labelledby="run-usage-spans-heading" className="min-w-0">
        <h2 id="run-usage-spans-heading" className="sr-only">
          Events by span
        </h2>
        {spans}
      </section>
      <section aria-labelledby="run-usage-data-section" className="min-w-0">
        <h2 id="run-usage-data-section" className="sr-only">
          Data written
        </h2>
        {data}
      </section>
    </div>
  );
}

const skeletonRow = (key: number, widths: [string, string]) => (
  <div
    key={key}
    className="flex h-[37px] items-center justify-between border-b border-gray-alpha-200"
  >
    <Skeleton className={cn('h-4', widths[0])} />
    <Skeleton className={cn('h-4', widths[1])} />
  </div>
);

/** The Usage page's geometry while its first read is pending. */
export function RunUsagePageSkeleton() {
  return (
    <div className="space-y-6 py-6" data-testid="run-usage-skeleton">
      <UsageTables
        spans={
          <div>
            <div className="flex h-[33px] items-center border-b border-gray-alpha-400">
              <Skeleton className="h-3 w-12" />
            </div>
            {skeletonRow(0, ['w-48', 'w-10'])}
            {[1, 2, 3, 4].map((i) => skeletonRow(i, ['w-40 ml-6', 'w-10']))}
            {skeletonRow(5, ['w-36 ml-6', 'w-10'])}
          </div>
        }
        data={
          <div>
            <div className="flex h-[33px] items-center border-b border-gray-alpha-400">
              <Skeleton className="h-3 w-32" />
            </div>
            {[0, 1, 2, 3, 4].map((i) => skeletonRow(i, ['w-16', 'w-12']))}
          </div>
        }
      />
    </div>
  );
}

function UsageFooter({ usage }: { usage: RunUsage }) {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-copy-13 text-gray-900">
      <span data-testid="run-usage-footer">
        {usage.billed ? (
          <span className="font-medium text-gray-1000">
            {formatUsageFooter(usage)}
          </span>
        ) : (
          formatUsageFooter(usage)
        )}
      </span>
      <span className="flex shrink-0 flex-wrap gap-x-4 gap-y-1">
        <a
          href={RUN_USAGE_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="-my-[3px] inline-block rounded-sm py-[3px] text-blue-900 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
        >
          How events are counted
        </a>
        <a
          href={WORKFLOW_PRICING_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="-my-[3px] inline-block rounded-sm py-[3px] text-blue-900 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
        >
          Workflow pricing
        </a>
      </span>
    </footer>
  );
}

/**
 * The run's Usage page (`/run/:runId/usage`): where its events and data
 * come from. The run header above it already shows the totals.
 */
export function RunUsagePage({
  runId,
  usage,
  error,
  onRetry,
  retrying = false,
}: {
  runId: string;
  /** `undefined` until the first read; `null` when the World has no usage. */
  usage: RunUsage | null | undefined;
  error: Error | null;
  /** Reads the usage again: a finished run does not poll. */
  onRetry?: () => void;
  retrying?: boolean;
}) {
  if (usage === null) {
    return (
      <div
        className="flex flex-col items-start gap-3 py-6"
        data-testid="run-usage-unsupported"
      >
        <p className="text-copy-14 text-gray-1000">
          This World doesn’t count run usage.
        </p>
        <p className="text-copy-13 text-gray-900">
          A run’s events and data written are counted on the Local World.
        </p>
        <Link
          to={runPath(runId)}
          className="-my-[3px] inline-block rounded-sm py-[3px] text-copy-13 text-blue-900 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
        >
          Back to run
        </Link>
      </div>
    );
  }
  if (!usage) {
    if (!error) return <RunUsagePageSkeleton />;
    return (
      <div
        className="flex flex-col items-start gap-3 py-6"
        data-testid="run-usage-error"
      >
        <div className="flex items-center gap-2 text-copy-13 text-red-800">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {failedMessage(error)}
        </div>
        {onRetry && (
          <Button
            variant="secondary"
            size="small"
            onClick={onRetry}
            loading={retrying}
            prefix={<RotateCw />}
          >
            Try again
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8 py-6" data-testid="run-usage-page">
      {error && (
        <output className="block text-copy-13 text-amber-800">
          Showing the last numbers read. Failed to refresh: {error.message}
        </output>
      )}
      <UsageTables
        spans={
          usage.eventsBySpan.length > 0 ? (
            <SpansTable usage={usage} />
          ) : (
            <p className="text-copy-13 text-gray-900">
              This run has no events yet.
            </p>
          )
        }
        data={<DataWrittenTable usage={usage} />}
      />
      <UsageFooter usage={usage} />
    </div>
  );
}
