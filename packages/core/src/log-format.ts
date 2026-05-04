import * as Ansi from '@workflow/errors/ansi';
import {
  formatStepName,
  formatWorkflowName,
  parseStepName,
  parseWorkflowName,
} from '@workflow/utils';

/**
 * Structured-log composition for `console.error` / `console.warn`. Emits
 * one string in three sections so the most useful information is at the
 * top, stack trace at the bottom:
 *
 *     [workflow-sdk] <framing line>
 *       user error · FatalError
 *       run    wrun_…
 *       step   step_… · add (./workflows/x)
 *       hint:  Move the call to a step function.
 *     FatalError: …
 *         at … (trimmed stack — internals collapsed)
 *
 * Without this composition, callers passing `${framing}\n${stack}` as the
 * message and structured fields as the metadata object got `util.inspect`'s
 * default object dump appended *after* the stack, which buries the run ID
 * and attribution badge under 30+ lines of `node_modules/.pnpm/...` frames.
 *
 * The same metadata is also emitted as structured OTel span events from
 * the logger itself, so backends that want JSON-shaped data still get it.
 * web/web-shared do not consume stderr at all — they read CBOR/JSON event
 * payloads from the World event log.
 */
export function composeLogLine(
  prefix: string,
  message: string,
  metadata: Record<string, unknown> | undefined
): string {
  const [framing, ...rest] = message.split('\n');
  const body = rest.join('\n');
  const fields = renderStructuredFields(framing ?? '', metadata);
  const trimmedBody = trimStackBody(body);

  const lines: string[] = [`${prefix} ${framing ?? ''}`];
  if (fields) lines.push(fields);
  if (trimmedBody) lines.push(trimmedBody);
  return lines.join('\n');
}

function renderStructuredFields(
  framing: string,
  metadata: Record<string, unknown> | undefined
): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;

  // Drop fields that the message already encodes. We render framings and
  // stacks into the message string itself in step-handler / runtime, so
  // repeating them here would be pure noise.
  const redundant = new Set<string>();
  redundant.add('errorStack');
  if (
    typeof metadata.errorMessage === 'string' &&
    framing.includes(metadata.errorMessage as string)
  ) {
    redundant.add('errorMessage');
  }

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

  // Header: error class + attribution badge.
  const errorName = pickString(metadata, 'errorName');
  const attribution = pickString(metadata, 'errorAttribution');
  if (errorName || attribution) {
    const badge = attribution
      ? attribution === 'sdk'
        ? Ansi.magenta('sdk error')
        : Ansi.red('user error')
      : '';
    const cls = errorName ? Ansi.bold(errorName) : '';
    const sep = badge && cls ? Ansi.dim(' · ') : '';
    lines.push(`  ${badge}${sep}${cls}`);
  }

  // ID + parsed friendly-name rows.
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

  if (metadata.attempt !== undefined || metadata.retryCount !== undefined) {
    // `attempt` and `retryCount` read ambiguously next to each other (is
    // "3 retries" the limit or what already happened?). Render the limit
    // as "max retries" to make the boundary explicit, and keep `attempt`
    // as the count of total invocations including the original.
    const a = metadata.attempt;
    const r = metadata.retryCount;
    if (a !== undefined && r !== undefined) {
      lines.push(
        `  ${kvKey('retry')} ${a} ${Ansi.dim('attempts ·')} ${r} ${Ansi.dim('max retries')}`
      );
    } else if (a !== undefined) {
      lines.push(`  ${kvKey('retry')} ${a} ${Ansi.dim('attempts')}`);
    }
  }

  const errorCode = pickString(metadata, 'errorCode');
  if (errorCode && errorCode !== errorName) {
    lines.push(`  ${kvKey('code')} ${Ansi.dim(errorCode)}`);
  }

  const hint = pickString(metadata, 'hint');
  if (hint) {
    lines.push(`  ${Ansi.hint(hint)}`);
  }

  // Sorted pass-through for unknown fields.
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

/**
 * Strip the stack down to frames the user can act on. V8 stacks for our
 * runtime errors look like:
 *
 *     Name: message
 *         at userStep (./workflows/foo.ts:12:11)
 *         at <unknown> (../../packages/core/src/runtime/step-handler.ts:535:32)
 *         at <unknown> (.../node_modules/.pnpm/next@…/…/base-server.js:1454:9)
 *         at <unknown> (.../node_modules/.pnpm/@opentelemetry+api@…/…/api.js:5440)
 *         at … (15 more frames into Next.js / pnpm internals)
 *
 * Two-pass trim:
 *
 *   1. Drop framework-internal frames (`node_modules/.pnpm/`, `node:internal/`,
 *      Turbopack-bundled `node_modules__pnpm_*` / `_next_dist_*` chunks).
 *   2. Cap the surviving frames at `MAX_VISIBLE_FRAMES` — past that, even
 *      "user-ish" frames are usually deep async wrapping that doesn't help
 *      pinpoint the throw. The user can drop into the inspect CLI for the
 *      full stack on demand.
 *
 * Each suppressed run emits one summary line so people know how much was
 * trimmed.
 */
const MAX_VISIBLE_FRAMES = 6;

function trimStackBody(body: string): string | null {
  if (!body) return null;
  const lines = body.split('\n');
  const out: string[] = [];
  let droppedRun = 0;
  let visibleFrameCount = 0;
  let cappedFrames = 0;

  const flushDropped = () => {
    if (droppedRun > 0) {
      out.push(
        Ansi.dim(
          `        … ${droppedRun} more ${droppedRun === 1 ? 'frame' : 'frames'} in framework internals`
        )
      );
      droppedRun = 0;
    }
  };

  for (const line of lines) {
    const isFrame = line.trimStart().startsWith('at ');
    if (isFrame && isFrameworkFrame(line)) {
      droppedRun++;
      continue;
    }
    if (isFrame && visibleFrameCount >= MAX_VISIBLE_FRAMES) {
      cappedFrames++;
      continue;
    }
    flushDropped();
    out.push(line);
    if (isFrame) visibleFrameCount++;
  }
  flushDropped();
  if (cappedFrames > 0) {
    out.push(
      Ansi.dim(
        `        … ${cappedFrames} more ${cappedFrames === 1 ? 'frame' : 'frames'} (run \`pnpm wf inspect run <id>\` for the full stack)`
      )
    );
  }
  return out.join('\n');
}

function isFrameworkFrame(line: string): boolean {
  // Only at-frames are candidates for stripping. Header lines (`Name: …`)
  // and arbitrary trailing context (e.g. `code: 'USER_ERROR'`) pass through.
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('at ')) return false;
  // node:* internals (timers, async hooks, vm, etc.) never help users.
  if (trimmed.includes('node:internal/')) return true;
  // pnpm-rooted frameworks installed as node_modules dependencies.
  if (trimmed.includes('node_modules/.pnpm/')) return true;
  // Turbopack/Next bundle the same framework code into chunks like
  // `node_modules__pnpm_<hash>._.js` and `<...>_next_dist_<hash>._.js`,
  // and emits Next.js loader runtime as `0dx6_next_dist_<hash>._.js`.
  // These are the frames that show up after Turbopack DCE — same intent
  // as the raw `node_modules/.pnpm/` filter above.
  if (trimmed.includes('node_modules__pnpm_')) return true;
  if (trimmed.includes('_next_dist_')) return true;
  // Plain node_modules (non-pnpm setups) for the same kinds of frameworks.
  if (
    trimmed.includes('node_modules/next/') ||
    trimmed.includes('node_modules/@opentelemetry/') ||
    trimmed.includes('node_modules/vitest/') ||
    trimmed.includes('node_modules/@vitest/')
  ) {
    return true;
  }
  return false;
}

function pickString(
  metadata: Record<string, unknown>,
  key: string
): string | null {
  const v = metadata[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function kvKey(key: string): string {
  return Ansi.dim(key.padEnd(6));
}

function formatIdRow(
  label: string,
  id: string | null,
  name: string | null,
  formatName: (n: string) => string
): string {
  const idCell = id ? id : Ansi.dim('—');
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
    if (v.includes('\n')) {
      return v
        .split('\n')
        .map((line, i) => (i === 0 ? line : `         ${line}`))
        .join('\n');
    }
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
