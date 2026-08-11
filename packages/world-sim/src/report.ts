/**
 * Rendering a scenario as text.
 *
 * The event stream is the primary artifact — it is the thing a reader checks
 * to answer "did the hook really land between `step_started` and the replay
 * that followed it?". So cues, deliveries and notes are interleaved into the
 * same column as events rather than printed as a separate log: the whole
 * point is their position relative to the events around them.
 *
 * Output is plain ASCII with no timestamps other than virtual offsets, which
 * makes a rendered scenario stable enough to check in as a golden file.
 */

import type { Event } from '@workflow/world';
import type { ScenarioResult } from './scenario.js';
import type { TraceEntry, WriterId } from './types.js';

export interface RenderOptions {
  /** Include `runs.get` / `events.list` style reads. Off by default: noisy. */
  verbose?: boolean;
  /** Maximum characters of decoded payload to show per event. */
  payloadWidth?: number;
}

const CHECK = 'ok';
const CROSS = 'FAIL';

function shortName(machineName: string | undefined): string | undefined {
  if (!machineName) return undefined;
  const parts = machineName.split('//');
  return parts[parts.length - 1] || machineName;
}

/** One-line summary of what an event carries, beyond its type. */
function describeEvent(event: Event, width: number): string {
  const data = (event as { eventData?: Record<string, unknown> }).eventData;
  const bits: string[] = [];

  switch (event.eventType) {
    case 'run_created':
    case 'run_started':
      if (data?.workflowName)
        bits.push(String(shortName(String(data.workflowName))));
      break;
    case 'step_created':
    case 'step_started':
    case 'step_completed':
    case 'step_failed':
    case 'step_retrying':
      if (data?.stepName) bits.push(String(shortName(String(data.stepName))));
      if (typeof data?.attempt === 'number')
        bits.push(`attempt=${data.attempt}`);
      break;
    case 'hook_created':
    case 'hook_received':
    case 'hook_disposed':
    case 'hook_conflict':
      if (data?.token) bits.push(`token=${JSON.stringify(data.token)}`);
      break;
    case 'wait_created':
    case 'wait_completed':
      if (data?.resumeAt) {
        bits.push(
          `resumeAt=${new Date(data.resumeAt as string).toISOString()}`
        );
      }
      break;
    case 'attr_set':
      bits.push(
        (data?.changes as { key: string }[] | undefined)
          ?.map((c) => c.key)
          .join(',') ?? ''
      );
      break;
    default:
      break;
  }

  // Payload fields are devalue/CBOR blobs; showing their size is more honest
  // than pretending to decode them here (the scenario result hydrates the run
  // output properly, which is the payload that usually matters).
  for (const field of [
    'input',
    'result',
    'output',
    'payload',
    'error',
    'metadata',
  ]) {
    const value = data?.[field];
    if (value instanceof Uint8Array) {
      bits.push(`${field}=<${value.byteLength}B>`);
    } else if (value !== undefined) {
      const text = JSON.stringify(value) ?? String(value);
      bits.push(
        `${field}=${text.length > width ? `${text.slice(0, width)}…` : text}`
      );
    }
  }

  return bits.filter(Boolean).join(' ');
}

function offset(atMs: number, epochMs: number): string {
  const delta = atMs - epochMs;
  if (delta === 0) return '+0ms';
  if (delta < 1000) return `+${delta}ms`;
  if (delta < 60_000) return `+${(delta / 1000).toFixed(1)}s`;
  if (delta < 3_600_000) return `+${(delta / 60_000).toFixed(1)}m`;
  if (delta < 86_400_000) return `+${(delta / 3_600_000).toFixed(1)}h`;
  return `+${(delta / 86_400_000).toFixed(1)}d`;
}

/**
 * Short form of a writer id for the trace's fixed-width writer column.
 *
 * The column answers the question the log itself cannot: two adjacent events
 * may have been committed by two different writers, and which one wrote which
 * is exactly what an interleaving scenario is about.
 */
function shortWriter(writer: WriterId | undefined): string {
  if (!writer) return '';
  if (writer === 'orchestrator') return 'wf';
  if (writer === 'external') return 'ext';
  return writer.startsWith('step:') ? writer.slice('step:'.length) : writer;
}

export function renderTrace(
  trace: readonly TraceEntry[],
  options: RenderOptions = {}
): string {
  const width = options.payloadWidth ?? 48;
  const epochMs = trace.length > 0 ? trace[0].atMs : 0;
  // Sized to the widest writer actually seen, so the common case (a run with
  // no steps, or short step names) does not pay for a name it never prints.
  const writerWidth = trace.reduce(
    (max, entry) =>
      entry.kind === 'event' || entry.kind === 'hold'
        ? Math.max(max, shortWriter(entry.writer).length)
        : max,
    2
  );
  const lines: string[] = [];
  let eventIndex = 0;

  for (const entry of trace) {
    const time = offset(entry.atMs, epochMs).padStart(8);
    // A depth > 0 entry happened inside a script action, i.e. inside another
    // world call. Indenting it is the visual proof of the ordering the
    // scenario asked for.
    const indent = '  '.repeat(entry.depth);
    const writer =
      entry.kind === 'event' || entry.kind === 'hold'
        ? `${shortWriter(entry.writer).padEnd(writerWidth)}  `
        : `${' '.repeat(writerWidth)}  `;

    switch (entry.kind) {
      case 'event': {
        const idx = String(eventIndex++).padStart(3);
        const detail = describeEvent(entry.event, width);
        const correlation = entry.event.correlationId
          ? ` ${entry.event.correlationId}`
          : '';
        lines.push(
          `${idx} ${time}  ${writer}${indent}${entry.event.eventType.padEnd(16)}${correlation}${
            detail ? `  ${detail}` : ''
          }`
        );
        break;
      }
      case 'hold':
        lines.push(
          `    ${time}  ${writer}${indent}>> held "${entry.label}" at ${entry.inside}`
        );
        break;
      case 'delivery':
        if (!options.verbose) break;
        lines.push(`    ${time}  ${writer}${indent}-- ${entry.message}`);
        break;
      case 'note':
        lines.push(`    ${time}  ${writer}${indent}// ${entry.message}`);
        break;
      case 'warn':
        lines.push(`    ${time}  ${writer}${indent}!! ${entry.message}`);
        break;
      case 'check':
        lines.push(
          `    ${time}  ${writer}${indent}${entry.ok ? CHECK : CROSS} check: ${entry.name}`
        );
        break;
    }
  }

  return lines.join('\n');
}

export function renderScenario(
  result: ScenarioResult,
  options: RenderOptions = {}
): string {
  const out: string[] = [];
  const status = result.ok ? 'PASS' : 'FAIL';

  out.push(`${status}  ${result.name}`);
  if (result.description) out.push(`      ${result.description}`);
  out.push(
    `      run=${result.runId || '(none)'} outcome=${result.outcome} ` +
      `events=${result.events.length} deliveries=${result.deliveries} ` +
      `worldCalls=${result.worldCalls} virtual=${formatDuration(result.virtualElapsedMs)} ` +
      `wall=${result.wallMs.toFixed(0)}ms replay=${describeReplay(result)}`
  );
  out.push('');
  out.push(renderTrace(result.trace, options));

  if (result.output !== undefined) {
    out.push('');
    out.push(`      output: ${safeJson(result.output)}`);
  }

  const attributes = result.run?.attributes ?? {};
  if (Object.keys(attributes).length > 0) {
    out.push('');
    out.push(`      attributes: ${safeJson(attributes)}`);
  }

  if (result.pending.length > 0) {
    out.push('');
    out.push(`      ${result.pending.length} message(s) still queued:`);
    for (const m of result.pending) {
      out.push(
        `        ${m.messageId} ready+${m.readyAtMs} deliveries=${m.deliveries}`
      );
    }
  }

  if (result.violations.length > 0) {
    out.push('');
    out.push('      CONSISTENCY VIOLATIONS');
    for (const v of result.violations) {
      out.push(`        [${v.rule}] ${v.message}`);
    }
  }

  if (result.problems.length > 0) {
    out.push('');
    out.push('      PROBLEMS');
    for (const p of result.problems) out.push(`        ${p}`);
  }

  return out.join('\n');
}

export function renderSummary(results: readonly ScenarioResult[]): string {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const violations = results.reduce((n, r) => n + r.violations.length, 0);
  return [
    '',
    `${results.length} scenario(s): ${passed} passed, ${failed} failed, ${violations} consistency violation(s)`,
  ].join('\n');
}

/** Short form of the cold-replay check for the summary line. */
function describeReplay(result: ScenarioResult): string {
  if (!result.replay) return 'not-run';
  if ('skipped' in result.replay) return 'skipped';
  const failed = result.violations.some((v) => v.rule.startsWith('replay.'));
  return failed ? 'MISMATCH' : 'ok';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
