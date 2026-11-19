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
  formatUsageBytes,
  formatUsageFooter,
  formatUsageShare,
  RUN_USAGE_ENTITIES,
  RUN_USAGE_RUN_EVENT_TYPES,
  type RunUsage,
  type RunUsageEntity,
  USAGE_COUNTING_DOCS_URL,
  USAGE_ROW_TYPE_LABELS,
  type UsageRow,
  type UsageRowGroup,
  type UsageRowType,
  usageRows,
  WORKFLOW_PRICING_DOCS_URL,
} from '@workflow/world';
import { AlertCircle, ChevronRight, HelpCircle, RotateCw } from 'lucide-react';
import { Fragment, type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import { Skeleton } from './ui/skeleton';

/** The docs section on what a run's storage counts. */
export const STORAGE_COUNTING_DOCS_URL =
  'https://workflow-sdk.dev/docs/observability#how-storage-is-counted';

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
 * The trace's icon for each row type, mapped the way the Events tab maps
 * event types: `run_*` and `attr_set` are the run's own (workflow icon),
 * sleeps are `sleep`, unknown event types get the generic icon.
 */
const ROW_RESOURCE: Record<UsageRowType, string> = {
  steps: 'step',
  hooks: 'hook',
  attributes: 'run',
  sleeps: 'sleep',
  run: 'run',
  other: 'event',
};

/** The trace's type icon. The row's visible type names it. */
function RowIcon({ type }: { type: UsageRowType }) {
  return (
    <span className="flex h-[18px] shrink-0 items-center" aria-hidden="true">
      <ResourceIcon resource={ROW_RESOURCE[type]} />
    </span>
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

/**
 * Secondary text after a row's name: calls, hooks, writes, event types. A
 * count stays on one line; a list (the run's event types) wraps, so on a
 * phone it does not push the table past the screen.
 */
function RowDetail({
  children,
  testId,
  wrap = false,
}: {
  children: ReactNode;
  testId: string;
  wrap?: boolean;
}) {
  return (
    <span
      className={cn(
        'font-sans text-label-12 text-gray-700',
        !wrap && 'whitespace-nowrap'
      )}
      data-testid={testId}
    >
      {children}
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
 * `Storage (local)` on a run that is not billed, `Storage` on one that is.
 * Before the first read answers, the backend decides: only the Local World
 * shows the field then.
 */
export function dataWrittenLabel(
  usage: RunUsage | undefined,
  isLocalBackend: boolean
): string {
  if (usage) return formatDataWrittenHeading(usage);
  return isLocalBackend ? 'Storage (local)' : 'Storage';
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
 * The run header's Events and Storage figures, from the World's count
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

const TABLE_HEAD_ROW =
  'text-label-12 text-gray-900 border-b border-gray-alpha-400';

/** What a group row says after its type: `9 calls`, `3 hooks`, `1 write`. */
function groupDetail(group: UsageRowGroup, usage: RunUsage): string | null {
  switch (group.type) {
    case 'steps':
      return formatCount(group.calls, 'call', 'calls');
    case 'hooks':
      return formatCount(group.calls, 'hook', 'hooks');
    case 'attributes':
      return formatCount(group.calls, 'write', 'writes');
    case 'sleeps':
      return formatCount(group.calls, 'sleep', 'sleeps');
    case 'run':
      return formatRunEventTypes(usage);
    default:
      return null;
  }
}

/**
 * A long step name or hook token, with break opportunities after the
 * characters that separate its parts (`approval:` `order-1042`,
 * `./src/workflows/`), so a narrow screen wraps it there rather than in
 * the middle of a word. The full label is also the row's tooltip.
 */
function BreakableLabel({ label }: { label: string }) {
  const parts = label.split(/(?<=[:/._-])/);
  return (
    <>
      {parts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed label
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/** The Events, share and retries cells every row has. */
function CountCells({
  row,
  emphasis = false,
}: {
  row: Pick<UsageRow, 'events' | 'share' | 'retries'>;
  emphasis?: boolean;
}) {
  return (
    <>
      <td
        className={cn(
          CELL,
          'text-right tabular-nums',
          emphasis && 'font-medium'
        )}
      >
        {row.events.toLocaleString('en-US')}
      </td>
      <td className={cn(CELL, 'hidden sm:table-cell')}>
        <ShareBar share={row.share} />
      </td>
      <td className={cn(CELL, 'text-right tabular-nums text-gray-900')}>
        {formatUsageShare(row.share)}
      </td>
      <td className="py-2">
        <RetryBadge retries={row.retries} />
      </td>
    </>
  );
}

const TOGGLE =
  '-my-[3px] -ml-1 flex min-w-0 items-start gap-2 rounded-sm py-[3px] pl-1 pr-1 text-left focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)]';

/**
 * One type of the table: its row, and for Steps and Hooks the rows under it
 * (each step function, each hook), behind a toggle that starts expanded.
 */
function UsageGroup({
  group,
  usage,
  idPrefix,
}: {
  group: UsageRowGroup;
  usage: RunUsage;
  idPrefix: string;
}) {
  const expandable = group.type === 'steps' || group.type === 'hooks';
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const label = USAGE_ROW_TYPE_LABELS[group.type];
  const detail = groupDetail(group, usage);
  const childrenId = `${idPrefix}-${group.type}`;
  // "+ N other steps" opens the rest: read the group again without a limit.
  const shown =
    expandable && showAll
      ? (usageRows(usage, Number.POSITIVE_INFINITY).find(
          (g) => g.type === group.type
        ) ?? group)
      : group;
  const name = (
    <>
      <RowIcon type={group.type} />
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span
          className="font-medium text-gray-1000"
          data-testid="run-usage-type-label"
        >
          {label}
        </span>
        {detail && (
          <RowDetail
            testId="run-usage-group-detail"
            wrap={group.type === 'run'}
          >
            {detail}
          </RowDetail>
        )}
      </span>
    </>
  );
  return (
    <>
      <tbody>
        <tr
          className="border-b border-gray-alpha-200"
          data-testid="run-usage-group"
          data-type={group.type}
        >
          <td className={CELL}>
            {expandable ? (
              <button
                type="button"
                className={TOGGLE}
                aria-expanded={expanded}
                aria-controls={childrenId}
                onClick={() => setExpanded((value) => !value)}
                data-testid="run-usage-toggle"
              >
                <span className="flex h-[18px] shrink-0 items-center">
                  <ChevronRight
                    className={cn(
                      'h-4 w-4 text-gray-900 motion-safe:transition-transform',
                      expanded && 'rotate-90'
                    )}
                    aria-hidden="true"
                  />
                </span>
                {name}
              </button>
            ) : (
              // Lines up with the toggles' labels: a chevron's width in.
              <div className="flex min-w-0 items-start gap-2 pl-6">{name}</div>
            )}
          </td>
          <CountCells row={group} emphasis />
        </tr>
      </tbody>
      {expandable && (
        <tbody
          id={childrenId}
          hidden={!expanded}
          data-testid="run-usage-children"
          data-type={group.type}
        >
          {shown.children.map((child) => (
            <tr
              key={child.key}
              className="border-b border-gray-alpha-200"
              data-testid="run-usage-child"
              data-key={child.key}
            >
              <td className={cn(CELL, 'pl-12')}>
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span
                    className="min-w-0 font-mono text-gray-1000 [overflow-wrap:anywhere]"
                    title={child.label}
                    data-testid="run-usage-child-label"
                  >
                    <BreakableLabel label={child.label} />
                  </span>
                  {group.type === 'steps' && (
                    <RowDetail testId="run-usage-calls">
                      {formatCount(child.calls, 'call', 'calls')}
                    </RowDetail>
                  )}
                </span>
              </td>
              <CountCells row={child} />
            </tr>
          ))}
          {shown.otherChildren && (
            <tr className="border-b border-gray-alpha-200">
              <td className={cn(CELL, 'pl-12')}>
                <button
                  type="button"
                  className="-my-[3px] rounded-sm py-[3px] text-gray-900 hover:text-gray-1000 underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
                  onClick={() => setShowAll(true)}
                >
                  {shown.otherChildren.label}
                </button>
              </td>
              <CountCells row={shown.otherChildren} />
            </tr>
          )}
        </tbody>
      )}
    </>
  );
}

/**
 * The run's events by type, the table `workflow inspect run --usage` prints:
 * Steps (each step function under it), Hooks (each hook, by token), then
 * Attributes, Sleeps and Run. Only the types the run has.
 */
function UsageTable({ usage }: { usage: RunUsage }) {
  const idPrefix = useId();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-copy-13" data-testid="run-usage-types">
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            <th className={cn(CELL, 'text-left font-medium')}>Type</th>
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
        {usageRows(usage).map((group) => (
          <UsageGroup
            key={group.key}
            group={group}
            usage={usage}
            idPrefix={idPrefix}
          />
        ))}
      </table>
    </div>
  );
}

/** The run's storage, by entity, with the total. */
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
          {RUN_USAGE_ENTITIES.filter(
            // Like the CLI: only the entities that wrote something.
            (entity) => usage.dataWritten.byEntity[entity] > 0
          ).map((entity) => (
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
            Storage × {usage.dataRetained.retentionMonths} month retention
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
          Events by type
        </h2>
        {spans}
      </section>
      <section aria-labelledby="run-usage-data-section" className="min-w-0">
        <h2 id="run-usage-data-section" className="sr-only">
          Storage
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
    <div className="space-y-6 pb-6 pt-2" data-testid="run-usage-skeleton">
      <UsageTables
        spans={
          <div>
            <div className="flex h-[33px] items-center border-b border-gray-alpha-400">
              <Skeleton className="h-3 w-12" />
            </div>
            {skeletonRow(0, ['w-28 ml-6', 'w-10'])}
            {[1, 2, 3].map((i) => skeletonRow(i, ['w-40 ml-12', 'w-10']))}
            {skeletonRow(4, ['w-28 ml-6', 'w-10'])}
            {skeletonRow(5, ['w-40 ml-12', 'w-10'])}
            {[6, 7, 8].map((i) => skeletonRow(i, ['w-24 ml-6', 'w-10']))}
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

const FOOTER_LINK =
  'whitespace-nowrap rounded-sm py-1 text-blue-900 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)]';

/**
 * One line under the tables: whether the run is billed, then the links, in
 * the same paragraph so they read as part of it and wrap with it. Pricing
 * is linked only where runs are billed (the Vercel backend).
 */
function UsageFooter({
  usage,
  isVercelBackend,
}: {
  usage: RunUsage;
  isVercelBackend: boolean;
}) {
  const showPricing = usage.billed || isVercelBackend;
  return (
    <footer className="text-copy-13 text-gray-900">
      <p data-testid="run-usage-footer-line">
        <span data-testid="run-usage-footer">
          {usage.billed ? (
            <span className="font-medium text-gray-1000">
              {formatUsageFooter(usage)}
            </span>
          ) : (
            formatUsageFooter(usage)
          )}
        </span>{' '}
        <a
          href={USAGE_COUNTING_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={FOOTER_LINK}
        >
          How events are counted<span aria-hidden="true"> →</span>
        </a>{' '}
        <a
          href={STORAGE_COUNTING_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={FOOTER_LINK}
        >
          How storage is counted<span aria-hidden="true"> →</span>
        </a>
        {showPricing && (
          <>
            {' '}
            <a
              href={WORKFLOW_PRICING_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={FOOTER_LINK}
            >
              Workflow pricing<span aria-hidden="true"> →</span>
            </a>
          </>
        )}
      </p>
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
  isVercelBackend = false,
}: {
  runId: string;
  /** `undefined` until the first read; `null` when the World has no usage. */
  usage: RunUsage | null | undefined;
  error: Error | null;
  /** Reads the usage again: a finished run does not poll. */
  onRetry?: () => void;
  retrying?: boolean;
  /** The backend is Vercel, where runs are billed: link the pricing. */
  isVercelBackend?: boolean;
}) {
  if (usage === null) {
    return (
      <div
        className="flex flex-col items-start gap-3 pb-6 pt-2"
        data-testid="run-usage-unsupported"
      >
        <p className="text-copy-14 text-gray-1000">
          This World doesn’t count run usage.
        </p>
        <p className="text-copy-13 text-gray-900">
          A run’s events and storage are counted on the Local World.
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
        className="flex flex-col items-start gap-3 pb-6 pt-2"
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
    <div className="space-y-8 pb-6 pt-2" data-testid="run-usage-page">
      {error && (
        <output className="block text-copy-13 text-amber-800">
          Showing the last numbers read. Failed to refresh: {error.message}
        </output>
      )}
      <UsageTables
        spans={
          usage.eventsBySpan.length > 0 ? (
            <UsageTable usage={usage} />
          ) : (
            <p className="text-copy-13 text-gray-900">
              This run has no events yet.
            </p>
          )
        }
        data={<DataWrittenTable usage={usage} />}
      />
      <UsageFooter usage={usage} isVercelBackend={isVercelBackend} />
    </div>
  );
}
