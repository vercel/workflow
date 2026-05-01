import * as Ansi from '@workflow/errors/ansi';
import {
  formatStepName,
  formatWorkflowName,
  parseStepName,
  parseWorkflowName,
} from '@workflow/utils';

/**
 * Pretty-format a structured-log metadata object for human consumption on
 * stderr. Designed to replace `util.inspect`'s default object dump for
 * `console.error('[workflow-sdk] msg', metadata)`-style calls — that form
 * works fine for small ad-hoc objects but produces a noisy, quote-escaped
 * blob when applied to the structured-error metadata that workflow runtime
 * logs emit (multi-line stack strings, hint paragraphs, parsed-name machine
 * tags).
 *
 * The pretty form:
 *
 *   - Renders well-known IDs (`workflowRunId`, `stepId`) with their parsed
 *     friendly names alongside the raw ID so users can copy the ID for
 *     lookup *and* see at a glance which workflow / step it refers to.
 *   - Drops fields that would just duplicate what's already in the log
 *     message — `errorMessage` when the message string already contains
 *     it, `errorStack` always (it should be in the message; we own the
 *     framing).
 *   - Color-codes attribution (`user error` red, `sdk error` magenta) so
 *     ownership is visually distinct.
 *   - Renders `hint` as a multi-line wrapped block under `hint:` so
 *     paragraph-length hints don't get backslash-escaped onto one line.
 *   - Aligns key/value pairs in two dim-padded columns.
 *
 * Important: web/web-shared do NOT consume stderr — they read CBOR/JSON
 * event payloads from the World event log. Changing the stderr format is
 * therefore a presentation-only change. The same metadata is also emitted
 * as structured OTel span events from the logger itself for backends that
 * want JSON-shaped data.
 *
 * Returns `null` when there's nothing useful to render (no surviving
 * fields after redundancy stripping); callers can then skip the trailing
 * block entirely instead of printing an empty separator.
 */
export function formatLogMetadata(
  message: string,
  metadata: Record<string, unknown> | undefined
): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;

  // Drop fields that the message already encodes. We render framings and
  // stacks into the message string itself in step-handler / runtime, so
  // repeating them as `errorStack: '...'` or `errorMessage: '...'` would
  // be pure noise.
  const redundant = new Set<string>();
  redundant.add('errorStack');
  if (
    typeof metadata.errorMessage === 'string' &&
    message.includes(metadata.errorMessage as string)
  ) {
    redundant.add('errorMessage');
  }

  // Pull well-known fields out for special-cased rendering. Anything not
  // matched here flows into the trailing key/value block as-is.
  const wellKnown = new Set([
    'workflowRunId',
    'workflowName',
    'stepId',
    'stepName',
    'errorAttribution',
    'errorCode',
    'errorName',
    'errorMessage',
    'errorStack',
    'hint',
    'attempt',
    'retryCount',
  ]);

  const lines: string[] = [];

  // Header: error class + attribution badge. Skips when neither is set
  // (e.g. info logs that just carry context).
  const errorName = pickString(metadata, 'errorName');
  const attribution = pickString(metadata, 'errorAttribution');
  if (errorName || attribution) {
    const badge = attribution
      ? attribution === 'sdk'
        ? Ansi.magenta(`sdk error`)
        : Ansi.red(`user error`)
      : '';
    const cls = errorName ? Ansi.bold(errorName) : '';
    const sep = badge && cls ? Ansi.dim(' · ') : '';
    lines.push(`  ${badge}${sep}${cls}`);
  }

  // ID + parsed name pairs. Display the raw ULID-shaped ID (users copy
  // these into URLs and the inspect CLI) alongside the parsed friendly
  // name so they don't have to mentally decode `step//./workflows/x//y`.
  const runId = pickString(metadata, 'workflowRunId');
  const wfName = pickString(metadata, 'workflowName');
  if (runId) {
    lines.push(formatIdRow('run', runId, wfName, formatWorkflowName));
  } else if (wfName) {
    lines.push(formatIdRow('run', null, wfName, formatWorkflowName));
  }

  const stepId = pickString(metadata, 'stepId');
  const stepName = pickString(metadata, 'stepName');
  if (stepId || stepName) {
    lines.push(formatIdRow('step', stepId, stepName, formatStepName));
  }

  // Retry-loop metadata, when present (only on the hit-max-retries log).
  if (metadata.attempt !== undefined || metadata.retryCount !== undefined) {
    const a = metadata.attempt;
    const r = metadata.retryCount;
    if (a !== undefined && r !== undefined) {
      lines.push(
        `  ${kvKey('retry')} ${a} ${Ansi.dim('attempts ·')} ${r} ${Ansi.dim('retries')}`
      );
    } else if (a !== undefined) {
      lines.push(`  ${kvKey('retry')} ${a} ${Ansi.dim('attempts')}`);
    }
  }

  // errorCode lives next to attribution conceptually; render it on its own
  // dim line right after the badge if it adds info beyond the name.
  const errorCode = pickString(metadata, 'errorCode');
  if (errorCode && errorCode !== errorName) {
    lines.push(`  ${kvKey('code')} ${Ansi.dim(errorCode)}`);
  }

  // Hint: paragraph-shaped, render dimmed under its own key so the
  // continuation reads clearly. We trust the hint to already be plain
  // text (we ban ANSI in error messages elsewhere).
  const hint = pickString(metadata, 'hint');
  if (hint) {
    lines.push(`  ${Ansi.hint(hint)}`);
  }

  // Pass-through for fields we don't know about — render them as
  // `key: value` in the trailing block so we never silently drop info.
  // Sort for stable output (helpful for snapshot tests).
  const passThrough = Object.entries(metadata)
    .filter(
      ([k, v]) =>
        !wellKnown.has(k) && !redundant.has(k) && v !== undefined && v !== null
    )
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of passThrough) {
    lines.push(`  ${kvKey(k)} ${formatPassthroughValue(v)}`);
  }

  return lines.length ? lines.join('\n') : null;
}

function pickString(
  metadata: Record<string, unknown>,
  key: string
): string | null {
  const v = metadata[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function kvKey(key: string): string {
  // Right-pad to a consistent column width so values line up vertically.
  return Ansi.dim(key.padEnd(6));
}

function formatIdRow(
  label: string,
  id: string | null,
  name: string | null,
  formatName: (n: string) => string
): string {
  // Compact form: `run    wrun_01KPYR1H596…  ·  simple (./workflows/1_simple)`
  const idCell = id ? id : Ansi.dim('—');
  // Only render the parsed name when parse succeeds and adds info beyond
  // the raw ID. Falls back silently otherwise.
  const parsed = name
    ? label === 'run'
      ? parseWorkflowName(name)
      : parseStepName(name)
    : null;
  const nameCell = parsed
    ? `${Ansi.dim('·')} ${formatName(name as string)}`
    : '';
  return `  ${kvKey(label)} ${idCell}${nameCell ? ' ' + nameCell : ''}`;
}

function formatPassthroughValue(v: unknown): string {
  if (typeof v === 'string') {
    // Multi-line strings: indent continuation lines so they line up under
    // the key column. Single-line stays as-is.
    if (v.includes('\n')) {
      return v
        .split('\n')
        .map((line, i) => (i === 0 ? line : `         ${line}`))
        .join('\n');
    }
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Objects / arrays: JSON-stringify compactly. Unlike util.inspect this
  // doesn't quote-escape multi-line strings inside them, but for the
  // structured metadata we emit (small POJOs) it's the right trade-off.
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
