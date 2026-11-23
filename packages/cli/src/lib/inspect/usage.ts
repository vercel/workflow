import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  formatCount,
  formatDataPurgedNote,
  formatDataWrittenHeading,
  formatDataWrittenNote,
  formatUsageAsOf,
  formatUsageBytes,
  formatUsageFooter,
  formatUsageShare,
  RUN_USAGE_ENTITIES,
  type RunUsage,
  type RunUsageEntity,
  USAGE_DOCS_URL,
  USAGE_ROW_TYPE_LABELS,
  type UsageRowGroup,
  usageRows,
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
  retries > 0 ? `↻ ${formatCount(retries, 'retry', 'retries')}` : '';

interface Row {
  type: string;
  name: string;
  events: string;
  share: string;
  extra: string;
  style: 'group' | 'child' | 'folded' | 'header' | 'total';
}

/** What a group's Name column says: how many of its kind it holds. */
function groupName(group: UsageRowGroup): string {
  switch (group.type) {
    case 'steps':
      return formatCount(group.calls, 'call', 'calls');
    case 'hooks':
      return formatCount(group.calls, 'hook', 'hooks');
    case 'attributes':
      return formatCount(group.calls, 'write', 'writes');
    case 'sleeps':
      return formatCount(group.calls, 'sleep', 'sleeps');
    default:
      return '';
  }
}

const joinParts = (...parts: string[]) => parts.filter(Boolean).join('  ');

/**
 * Control characters (C0, DEL and C1), the ones a terminal acts on: `\x1b`
 * starts an escape sequence, `\x9b` is its one-character form, a newline
 * breaks the table. Names in a run's data (a hook token, a step or workflow
 * name) come from the app and are printed through this.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the characters to escape
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const NAMED_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/**
 * `text` with each control character written out (`\x1b`, `\n`) instead
 * of sent to the terminal. Nothing is dropped, and the escaped form is what
 * the columns are padded by, so the table still lines up.
 */
export function escapeControlChars(text: string): string {
  return text.replace(
    CONTROL_CHARS,
    (char) =>
      NAMED_ESCAPES[char] ??
      `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
  );
}

/**
 * `inspect run <id> --usage`, as text, from `RunUsage` and the shared
 * `@workflow/world` formatters.
 */
export function formatRunUsageText(
  usage: RunUsage,
  {
    color = false,
    pricing = false,
  }: {
    color?: boolean;
    /** Link the pricing page: only for a run on Vercel's backend. */
    pricing?: boolean;
  } = {}
): string {
  const c = new Chalk({ level: color ? 1 : 0 });
  const lines: string[] = [];
  // Everything from the run's data is escaped before it is printed.
  const workflow = escapeControlChars(
    parseWorkflowName(usage.workflowName)?.shortName || usage.workflowName
  );

  lines.push(
    `${c.bold(workflow)}  ${escapeControlChars(usage.runId)}  ${statusColor(c, usage.status)('●')} ${escapeControlChars(usage.status)}`
  );
  if (usage.inProgress) {
    lines.push(c.dim('This run has not finished; its usage can still grow.'));
  }
  // Usage read from analytics, which can lag (absent on a local run).
  const asOf = formatUsageAsOf(usage);
  if (asOf) lines.push(c.dim(escapeControlChars(asOf)));
  lines.push('');

  // Summary block. Retries are on the step rows.
  const summary: [string, string][] = [
    ['Events', usage.events.toLocaleString('en-US')],
    [
      formatDataWrittenHeading(usage),
      formatUsageBytes(usage.dataWritten.bytes),
    ],
  ];
  const labelWidth = Math.max(...summary.map(([label]) => label.length));
  for (const [label, value] of summary) {
    lines.push(`${c.dim(label.padEnd(labelWidth))}  ${value}`);
  }

  // One flat list: each type, with steps and hooks under theirs.
  const body: Row[] = [];
  for (const group of usageRows(usage)) {
    body.push({
      type: USAGE_ROW_TYPE_LABELS[group.type],
      name: joinParts(groupName(group), retryTag(group.retries)),
      events: group.events.toLocaleString('en-US'),
      share: formatUsageShare(group.share),
      extra: bar(group.share),
      style: 'group',
    });
    const children: Row[] = [
      ...group.children.map(
        (child): Row => ({
          type: '',
          name: joinParts(
            // A step function's name or a hook's token, from the run.
            escapeControlChars(child.label),
            // A hook is one hook: only a step function has calls to count.
            group.type === 'steps'
              ? formatCount(child.calls, 'call', 'calls')
              : '',
            retryTag(child.retries)
          ),
          events: child.events.toLocaleString('en-US'),
          share: formatUsageShare(child.share),
          extra: bar(child.share),
          style: 'child',
        })
      ),
      ...(group.otherChildren
        ? [
            {
              type: '',
              name: joinParts(
                group.otherChildren.label,
                retryTag(group.otherChildren.retries)
              ),
              events: group.otherChildren.events.toLocaleString('en-US'),
              share: formatUsageShare(group.otherChildren.share),
              extra: '',
              style: 'folded' as const,
            },
          ]
        : []),
    ];
    children.forEach((row, i) => {
      row.name = `${i === children.length - 1 ? '└─' : '├─'} ${row.name}`;
    });
    body.push(...children);
  }
  const rows: Row[] = [
    {
      type: 'TYPE',
      name: 'NAME',
      events: 'EVENTS',
      share: 'SHARE',
      extra: '',
      style: 'header',
    },
    ...body,
    {
      type: 'TOTAL',
      name: '',
      events: usage.events.toLocaleString('en-US'),
      share: usage.events > 0 ? '100%' : '',
      extra: '',
      style: 'total',
    },
  ];
  const width = {
    type: Math.max(...rows.map((row) => row.type.length)),
    name: Math.max(...rows.map((row) => row.name.length)),
    events: Math.max(...rows.map((row) => row.events.length)),
    share: Math.max(...rows.map((row) => row.share.length)),
  };
  lines.push('');
  for (const row of rows) {
    const text = [
      row.type.padEnd(width.type),
      row.name.padEnd(width.name),
      row.events.padStart(width.events),
      row.share.padStart(width.share),
      row.extra,
    ]
      .join('  ')
      .trimEnd();
    lines.push(
      row.style === 'header' || row.style === 'folded'
        ? c.dim(text)
        : row.style === 'group' || row.style === 'total'
          ? c.bold(text)
          : text
    );
  }

  // What each event is, and what storage counts, live in the docs.
  lines.push('');
  lines.push(c.dim(`How usage is counted: ${USAGE_DOCS_URL}`));

  // Storage, without the entities that wrote nothing.
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
  // What a billed run's storage leaves out. Not printed for a local run,
  // whose output stays as the docs show it.
  if (usage.billed) lines.push(c.dim(formatDataWrittenNote(usage)));
  if (usage.dataRetained) {
    lines.push(
      `Data retained: ${formatUsageBytes(usage.dataRetained.byteMonths)}-months (${usage.dataRetained.retentionMonths} month retention)`
    );
  }

  lines.push('');
  lines.push(formatUsageFooter(usage));
  // Pricing applies to runs Vercel bills, not to a local run.
  if (pricing) lines.push(`See pricing: ${WORKFLOW_PRICING_DOCS_URL}`);
  lines.push(c.dim('Machine-readable: --json'));
  return lines.join('\n');
}
