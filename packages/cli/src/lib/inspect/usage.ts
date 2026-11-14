import {
  collapseUsageSpans,
  EVENTS_PER_RETRY,
  formatRunUsageSummary,
  formatStepCreationNote,
  formatStepEventsBreakdown,
  formatUsageBytes,
  formatUsageEvents,
  formatUsageShare,
  RUN_USAGE_ENTITIES,
  type RunUsage,
  type RunUsageEntity,
  usageSpanLabel,
  WORKFLOW_PRICING_DOCS_URL,
} from '@workflow/world';

const ENTITY_LABELS: Record<RunUsageEntity, string> = {
  run: 'Run',
  step: 'Steps',
  hook: 'Hooks',
  stream: 'Streams',
};

function table(rows: string[][], align: ('left' | 'right')[]): string[] {
  const widths = align.map((_, col) =>
    Math.max(...rows.map((row) => (row[col] ?? '').length))
  );
  return rows.map((row) =>
    row
      .map((cell, col) =>
        align[col] === 'right'
          ? cell.padStart(widths[col])
          : cell.padEnd(widths[col])
      )
      .join('  ')
      .trimEnd()
  );
}

/**
 * `inspect run <id> --usage`, as plain text: the numbers the web UI's Usage
 * tab shows, from the same `RunUsage`.
 */
export function formatRunUsageText(usage: RunUsage): string {
  const lines: string[] = [];
  lines.push(`Usage for ${usage.runId} (${usage.status})`);
  if (usage.inProgress) {
    lines.push('This run has not finished; its usage can still grow.');
  }
  lines.push('');
  lines.push(formatRunUsageSummary(usage));

  if (usage.eventsBySpan.length > 0) {
    const [top] = usage.eventsBySpan;
    lines.push('');
    lines.push('Where the events come from');
    lines.push(
      `  ${usageSpanLabel(top)} drives ${formatUsageShare(top.share)} of this run's events (${formatUsageEvents(top.events)}).`
    );
    lines.push('');
    const { shown, other } = collapseUsageSpans(usage.eventsBySpan);
    const rows = [
      ['Span', 'Events', 'Share', 'Retries'],
      ...shown.map((span) => [
        usageSpanLabel(span),
        span.events.toLocaleString('en-US'),
        formatUsageShare(span.share),
        span.retries > 0 ? String(span.retries) : '',
      ]),
    ];
    if (other) {
      rows.push([
        `${other.spans} other spans`,
        other.events.toLocaleString('en-US'),
        formatUsageShare(other.share),
        other.retries > 0 ? String(other.retries) : '',
      ]);
    }
    for (const line of table(rows, ['left', 'right', 'right', 'right'])) {
      lines.push(`  ${line}`);
    }
  }

  const stepBreakdown = formatStepEventsBreakdown(usage);
  const stepCreationNote = formatStepCreationNote(usage);
  lines.push('');
  lines.push('How events are counted');
  if (stepBreakdown) lines.push(`  ${stepBreakdown}.`);
  if (stepCreationNote) lines.push(`  ${stepCreationNote}`);
  lines.push(
    `  Each retry adds ${EVENTS_PER_RETRY}: a retry marker, and the step starting again.`
  );

  lines.push('');
  lines.push('Data written');
  const storageRows = RUN_USAGE_ENTITIES.map((entity) => [
    ENTITY_LABELS[entity],
    formatUsageBytes(usage.dataWritten.byEntity[entity]),
  ]);
  storageRows.push(['Total', formatUsageBytes(usage.dataWritten.bytes)]);
  for (const line of table(storageRows, ['left', 'right'])) {
    lines.push(`  ${line}`);
  }
  if (usage.dataRetained) {
    lines.push('');
    lines.push(
      `Data retained: ${formatUsageBytes(usage.dataRetained.byteMonths)}-months (${usage.dataRetained.retentionMonths} month retention)`
    );
  }

  lines.push('');
  lines.push(`Not your final bill. See pricing: ${WORKFLOW_PRICING_DOCS_URL}`);
  return lines.join('\n');
}
