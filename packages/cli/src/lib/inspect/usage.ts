import {
  formatBillableNote,
  formatDataPurgedNote,
  formatDataWrittenHeading,
  formatEventCountingNote,
  formatEventsWithRetries,
  formatUsageBytes,
  formatUsageFooter,
  formatUsageShare,
  RUN_USAGE_ENTITIES,
  type RunUsage,
  type RunUsageEntity,
  type UsageSpanTreeRow,
  usageSpanTree,
  WORKFLOW_PRICING_DOCS_URL,
  type WorkflowRunStatus,
} from '@workflow/world';
import { Chalk, type ChalkInstance } from 'chalk';

const ENTITY_LABELS: Record<RunUsageEntity, string> = {
  run: 'Run',
  step: 'Steps',
  hook: 'Hooks',
  stream: 'Streams',
};

const BAR_WIDTH = 10;

/**
 * Whether to print in color: only to a terminal, and never with `NO_COLOR`
 * set or `TERM=dumb`. Piped output is plain text.
 */
export function usageTextColor(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    Boolean(stream.isTTY) && env.NO_COLOR === undefined && env.TERM !== 'dumb'
  );
}

function statusColor(c: ChalkInstance, status: WorkflowRunStatus) {
  switch (status) {
    case 'completed':
      return c.green;
    case 'failed':
      return c.red;
    case 'cancelled':
      return c.gray;
    default:
      return c.blue;
  }
}

/** A 10-character bar for a share of the run's events. */
function bar(share: number): string {
  const filled = share > 0 ? Math.max(1, Math.round(share * BAR_WIDTH)) : 0;
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

const retryTag = (retries: number) =>
  retries > 0 ? `↻ ${retries} ${retries === 1 ? 'retry' : 'retries'}` : '';

interface Row {
  name: string;
  events: string;
  share: string;
  extra: string;
  style: 'workflow' | 'step' | 'builtIn' | 'header' | 'total';
}

/**
 * `inspect run <id> --usage`, as text, from `RunUsage` and the shared
 * `@workflow/world` formatters.
 */
export function formatRunUsageText(
  usage: RunUsage,
  { color = false }: { color?: boolean } = {}
): string {
  const c = new Chalk({ level: color ? 1 : 0 });
  const lines: string[] = [];
  const tree = usageSpanTree(usage);

  lines.push(
    `${c.bold(tree.workflow.label)}  ${usage.runId}  ${statusColor(c, usage.status)('●')} ${usage.status}`
  );
  if (usage.inProgress) {
    lines.push(c.dim('This run has not finished; its usage can still grow.'));
  }
  lines.push('');

  // Summary block.
  const { events, retries } = formatEventsWithRetries(usage);
  const local = usage.billed ? '' : ' (local)';
  const summary: [string, string][] = [
    ['Events', `${events}  (${retries})`],
    ['Data written', `${formatUsageBytes(usage.dataWritten.bytes)}${local}`],
  ];
  const billable = formatBillableNote(usage);
  if (billable) {
    summary.push([
      'On Vercel',
      `${usage.billableEvents.toLocaleString('en-US')} billable events`,
    ]);
  }
  const labelWidth = Math.max(...summary.map(([label]) => label.length));
  for (const [label, value] of summary) {
    lines.push(`${c.dim(label.padEnd(labelWidth))}  ${value}`);
  }

  // The span tree: the workflow, its steps, the built-in rows, a total.
  const children: Row[] = [
    ...tree.steps.map((row) => stepRow(row)),
    ...(tree.otherSteps
      ? [
          {
            name: `+ ${tree.otherSteps.steps} more steps`,
            events: tree.otherSteps.events.toLocaleString('en-US'),
            share: formatUsageShare(tree.otherSteps.share),
            extra: '',
            style: 'step' as const,
          },
        ]
      : []),
    ...tree.builtIns.map(
      (row): Row => ({
        name: row.kind === 'run' ? row.label : `${row.label}  ×${row.calls}`,
        events: row.events.toLocaleString('en-US'),
        share: formatUsageShare(row.share),
        extra: '',
        style: 'builtIn',
      })
    ),
  ];
  children.forEach((row, i) => {
    row.name = `${i === children.length - 1 ? '└─' : '├─'} ${row.name}`;
  });
  const rows: Row[] = [
    {
      name: 'NAME',
      events: 'EVENTS',
      share: 'SHARE',
      extra: '',
      style: 'header',
    },
    {
      name: `${tree.workflow.label}  workflow`,
      events: tree.workflow.events.toLocaleString('en-US'),
      share: '',
      extra: '',
      style: 'workflow',
    },
    ...children,
    {
      name: 'TOTAL',
      events: usage.events.toLocaleString('en-US'),
      share: usage.events > 0 ? '100%' : '',
      extra: '',
      style: 'total',
    },
  ];
  const width = {
    name: Math.max(...rows.map((row) => row.name.length)),
    events: Math.max(...rows.map((row) => row.events.length)),
    share: Math.max(...rows.map((row) => row.share.length)),
  };
  lines.push('');
  for (const row of rows) {
    const text = [
      row.name.padEnd(width.name),
      row.events.padStart(width.events),
      row.share.padStart(width.share),
      row.extra,
    ]
      .join('  ')
      .trimEnd();
    lines.push(
      row.style === 'header'
        ? c.dim(text)
        : row.style === 'workflow' || row.style === 'total'
          ? c.bold(text)
          : row.style === 'builtIn'
            ? c.dim(text)
            : text
    );
  }

  // How the step events add up, and what a retry adds: two lines of the
  // shared "How events are counted".
  lines.push('');
  for (const line of formatEventCountingNote(usage)) lines.push(c.dim(line));

  // Data written, without the entities that wrote nothing.
  lines.push('');
  const dataRows = RUN_USAGE_ENTITIES.filter(
    (entity) => usage.dataWritten.byEntity[entity] > 0
  ).map((entity) => [
    ENTITY_LABELS[entity],
    formatUsageBytes(usage.dataWritten.byEntity[entity]),
  ]);
  const dataTable = [
    [formatDataWrittenHeading(usage).toUpperCase(), 'SIZE'],
    ...dataRows,
    ['TOTAL', formatUsageBytes(usage.dataWritten.bytes)],
  ];
  const dataWidth = [
    Math.max(...dataTable.map((row) => row[0].length)),
    Math.max(...dataTable.map((row) => row[1].length)),
  ];
  dataTable.forEach((row, i) => {
    const text = `${row[0].padEnd(dataWidth[0])}  ${row[1].padStart(dataWidth[1])}`;
    lines.push(
      i === 0 ? c.dim(text) : i === dataTable.length - 1 ? c.bold(text) : text
    );
  });
  const purged = formatDataPurgedNote(usage);
  if (purged) lines.push(c.dim(purged));
  if (usage.dataRetained) {
    lines.push(
      `Data retained: ${formatUsageBytes(usage.dataRetained.byteMonths)}-months (${usage.dataRetained.retentionMonths} month retention)`
    );
  }

  lines.push('');
  lines.push(formatUsageFooter(usage));
  lines.push(`See pricing: ${WORKFLOW_PRICING_DOCS_URL}`);
  lines.push(c.dim('Machine-readable: --json'));
  return lines.join('\n');

  function stepRow(row: UsageSpanTreeRow): Row {
    const tag = retryTag(row.retries);
    return {
      name: `${row.label}  ×${row.calls}${tag ? `  ${tag}` : ''}`,
      events: row.events.toLocaleString('en-US'),
      share: formatUsageShare(row.share),
      extra: bar(row.share),
      style: 'step',
    };
  }
}
