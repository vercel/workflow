/**
 * Rendering a scenario as text.
 *
 * The event stream is the primary artifact: it is the thing a reader checks
 * to answer "did the hook really land between `step_started` and the replay
 * that followed it?". So cues, deliveries and notes are interleaved into the
 * same column as events rather than printed as a separate log: the whole
 * point is their position relative to the events around them.
 *
 * **Events are referred to one way and one way only: by log position.** `#12`
 * is the twelfth event in the durable log (the log sorted the way
 * `events.list` sorts it, `(createdAt, eventId)`), and `@7` is a reference to
 * the resource created at position 7. Raw ULIDs never appear; the ids in
 * violation messages are rewritten to positions on the way out. One scheme,
 * so "the hook is at 7 and `wait_completed` at 8" is a claim a reader can
 * check against the output rather than translate first.
 *
 * The consequence worth knowing: the trace prints in *commit* order but is
 * numbered in *log* order, so a run whose durable log disagrees with the order
 * its writers actually committed in shows up as positions counting backwards.
 * Those lines are highlighted. That disagreement is the entire subject of the
 * red scenarios, and this is where you see it.
 *
 * Color is decoration over that: it is applied only when the destination is a
 * terminal, and is off under `NO_COLOR` or `--no-color`. With color off the
 * output is the same plain ASCII it always was, stable enough to check in as a
 * golden file.
 */

import type { Event } from '@workflow/world';
import { describeStartOutcome, type ScenarioResult } from './scenario.js';
import type { TraceEntry, WriterId } from './types.js';

export interface RenderOptions {
  /** Include `runs.get` / `events.list` style reads. Off by default: noisy. */
  verbose?: boolean;
  /** Maximum characters of decoded payload to show per event. */
  payloadWidth?: number;
  /**
   * ANSI color. Defaults to "on if stdout is a TTY and `NO_COLOR` is unset",
   * so piping to a file or a golden-file comparison gets plain ASCII without
   * anyone having to remember a flag.
   */
  color?: boolean;
}

/** `RenderOptions` plus what `renderScenario` knows about the runs. */
interface TraceRenderOptions extends RenderOptions {
  /** Run ids to label even if the trace never names them. */
  runIds?: readonly string[];
}

const CHECK = 'ok';
const CROSS = 'FAIL';

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/** SGR codes, applied through `Paint` so a no-color render never sees them. */
const SGR = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
} as const;

type Style = keyof typeof SGR;

/**
 * A `paint(text, ...styles)` function that is either real or the identity.
 *
 * Resolving the on/off decision once, into a function, keeps every call site
 * free of `if (color)`, which matters because getting one of them wrong is
 * how escape codes leak into a file that was supposed to be diffable.
 */
type Paint = (text: string, ...styles: Style[]) => string;

const plain: Paint = (text) => text;

const ESC = '\u001b[';

const ansi: Paint = (text, ...styles) =>
  styles.length === 0
    ? text
    : `${ESC}${styles.map((s) => SGR[s]).join(';')}m${text}${ESC}${SGR.reset}m`;

function colorEnabled(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout?.isTTY);
}

function painter(options: RenderOptions): Paint {
  return colorEnabled(options.color) ? ansi : plain;
}

/**
 * Colour by event family, so a trace can be skimmed for shape before it is
 * read for content: where the hooks are, where the waits are, and whether
 * anything went red.
 */
function eventStyle(eventType: string): Style {
  if (/(_failed|_cancelled|_conflict)$/.test(eventType)) return 'red';
  if (eventType.startsWith('run_')) return 'magenta';
  if (eventType.startsWith('step_')) return 'cyan';
  if (eventType.startsWith('hook_')) return 'green';
  if (eventType.startsWith('wait_')) return 'blue';
  if (eventType.startsWith('attr_')) return 'yellow';
  return 'gray';
}

// ---------------------------------------------------------------------------
// Event references
// ---------------------------------------------------------------------------

/**
 * Log positions for every event in a trace.
 *
 * Built by sorting the events the way `events.list` does, *not* by the order
 * they were committed in: the two differ exactly when something interesting
 * happened, and the number has to describe the durable log for a reader to be
 * able to reason about what a replay will see.
 */
interface EventIndex {
  /**
   * Log position of an event, by its id, within its own run's log. Without a
   * run, only an id no other run's log shares resolves: event ids are slot
   * numbers, so every run has a `#0`.
   */
  position(eventId: string, runId?: string): number | undefined;
  /** Log position at which a correlationId first appears. */
  origin(correlationId: string): number | undefined;
  /** Width of the widest position, for column alignment. */
  width: number;
}

function buildEventIndex(trace: readonly TraceEntry[]): EventIndex {
  const events = trace
    .filter((e): e is Extract<TraceEntry, { kind: 'event' }> => {
      return e.kind === 'event';
    })
    .map((e) => e.event);

  const sorted = [...events].sort((a, b) => {
    const at = a.createdAt.getTime();
    const bt = b.createdAt.getTime();
    if (at !== bt) return at - bt;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });

  // Each run's log is numbered on its own, the way a reader of that run's
  // `events.list` would number it.
  const positions = new Map<string, number>();
  const byId = new Map<string, number | null>();
  const origins = new Map<string, number>();
  const nextInRun = new Map<string, number>();
  let widest = 0;
  for (const event of sorted) {
    const i = nextInRun.get(event.runId) ?? 0;
    nextInRun.set(event.runId, i + 1);
    widest = Math.max(widest, i);
    positions.set(`${event.runId}|${event.eventId}`, i);
    byId.set(event.eventId, byId.has(event.eventId) ? null : i);
    if (event.correlationId && !origins.has(event.correlationId)) {
      origins.set(event.correlationId, i);
    }
  }

  return {
    position: (eventId, runId) =>
      runId !== undefined
        ? positions.get(`${runId}|${eventId}`)
        : (byId.get(eventId) ?? undefined),
    origin: (correlationId) => origins.get(correlationId),
    width: Math.max(2, String(widest).length),
  };
}

/**
 * Short names for the runs a trace mentions, once it mentions more than one:
 * `r1`, `r2`, … in order of first appearance, whether as an event's run or
 * as an id inside a message (a refused candidate is never a run, and appears
 * only there). A trace of one run gets none, and prints as it always has.
 */
interface RunLabels {
  multi: boolean;
  of(runId: string): string | undefined;
  /** Replace run ids in free text with their labels. */
  rewrite(text: string): string;
  entries(): [runId: string, label: string][];
}

const RUN_ID = /\bwrun_[0-9A-Za-z]+\b/g;

function buildRunLabels(
  trace: readonly TraceEntry[],
  extra: readonly string[] = []
): RunLabels {
  const labels = new Map<string, string>();
  const see = (runId: string) => {
    if (!labels.has(runId)) labels.set(runId, `r${labels.size + 1}`);
  };
  for (const entry of trace) {
    if (entry.kind === 'event') see(entry.event.runId);
    else if ('message' in entry) {
      for (const id of entry.message.match(RUN_ID) ?? []) see(id);
    } else if (entry.kind === 'hold') {
      for (const id of entry.label.match(RUN_ID) ?? []) see(id);
    }
  }
  for (const id of extra) see(id);
  const multi = labels.size > 1;
  return {
    multi,
    of: (runId) => (multi ? labels.get(runId) : undefined),
    rewrite: (text) =>
      multi ? text.replace(RUN_ID, (id) => labels.get(id) ?? id) : text,
    entries: () => [...labels.entries()],
  };
}

/** `#12`, padded to the trace's position column. */
function eventRef(position: number | undefined, width: number): string {
  return position === undefined
    ? `#${'?'.padStart(width)}`
    : `#${String(position).padStart(width)}`;
}

/** `@7`: the resource created at position 7. */
function resourceRef(position: number | undefined): string {
  return position === undefined ? '@?' : `@${position}`;
}

/**
 * Rewrite raw event ids in a message into `#N` log positions.
 *
 * Invariant and replay violations are written by code that only has ids to
 * hand. Translating here rather than there keeps the one-scheme promise
 * without making every check carry a positional index it has no other use
 * for.
 */
function withRefs(
  message: string,
  index: EventIndex,
  runs?: RunLabels,
  runId?: string
): string {
  const refs = message.replace(/\bevnt_[0-9A-Za-z]+\b/g, (id) => {
    const position = index.position(id, runId);
    return position === undefined ? id : `#${position}`;
  });
  return runs ? runs.rewrite(refs) : refs;
}

// ---------------------------------------------------------------------------
// Event detail
// ---------------------------------------------------------------------------

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
    case 'run_started': {
      if (data?.workflowName)
        bits.push(String(shortName(String(data.workflowName))));
      const startHook = data?.startHook as { token?: string } | undefined;
      if (startHook?.token) {
        bits.push(`startHook=${JSON.stringify(startHook.token)}`);
      }
      break;
    }
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
    case 'hook_conflict': {
      if (data?.token) bits.push(`token=${JSON.stringify(data.token)}`);
      if (data?.force === true) bits.push('force');
      if (typeof data?.conflictingRunId === 'string') {
        bits.push(`owner=${data.conflictingRunId}`);
      }
      const from = data?.forceClaimedFrom as { runId?: string } | undefined;
      if (from?.runId) bits.push(`from=${from.runId}`);
      const by = data?.forceClaimedBy as { runId?: string } | undefined;
      if (by?.runId) bits.push(`forceClaimedBy=${by.runId}`);
      break;
    }
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
  options: TraceRenderOptions = {}
): string {
  const paint = painter(options);
  const width = options.payloadWidth ?? 48;
  const index = buildEventIndex(trace);
  const runs = buildRunLabels(trace, options.runIds);
  // A trace of several runs prefixes each event with its run's label, since
  // each run's log is numbered on its own.
  const labelWidth = runs.multi
    ? Math.max(...runs.entries().map(([, label]) => label.length)) + 1
    : 0;
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
  const blank = ' '.repeat(labelWidth + index.width + 1);
  const lines: string[] = [];
  // Highest log position printed so far, per run. A line below it is an event
  // that was committed after one that outranks it in the log, the
  // disagreement the six red scenarios are about.
  const highWater = new Map<string, number>();

  for (const entry of trace) {
    const time = paint(offset(entry.atMs, epochMs).padStart(8), 'dim');
    // A depth > 0 entry happened inside a script action, i.e. inside another
    // world call. Indenting it is the visual proof of the ordering the
    // scenario asked for.
    const indent = '  '.repeat(entry.depth);
    const writerName =
      entry.kind === 'event' || entry.kind === 'hold'
        ? shortWriter(entry.writer)
        : '';
    // Pad before painting: `padEnd` counts escape bytes, so a colored column
    // padded afterwards comes out short by however long the escape is.
    const writer =
      entry.kind === 'event' || entry.kind === 'hold'
        ? `${paint(
            writerName.padEnd(writerWidth),
            writerName === 'ext' ? 'magenta' : 'dim'
          )}  `
        : `${' '.repeat(writerWidth)}  `;

    switch (entry.kind) {
      case 'event': {
        const runId = entry.event.runId;
        const position = index.position(entry.event.eventId, runId);
        const high = highWater.get(runId) ?? -1;
        const backwards = position !== undefined && position < high;
        if (position !== undefined && position > high)
          highWater.set(runId, position);

        const label = runs.of(runId);
        const ref = `${label ? `${label.padEnd(labelWidth - 1)} ` : ''}${eventRef(position, index.width)}`;
        const type = entry.event.eventType;
        const correlation = entry.event.correlationId
          ? ` ${paint(
              resourceRef(index.origin(entry.event.correlationId)),
              'gray'
            )}`
          : '';
        const detail = runs.rewrite(describeEvent(entry.event, width));

        lines.push(
          `${paint(ref, ...(backwards ? (['yellow', 'bold'] as const) : (['dim'] as const)))} ${time}  ` +
            `${writer}${indent}${paint(type.padEnd(16), eventStyle(type))}` +
            `${correlation}${detail ? `  ${paint(detail, 'dim')}` : ''}`
        );
        break;
      }
      case 'hold':
        lines.push(
          `${blank} ${time}  ${writer}${indent}${paint(`>> held "${runs.rewrite(entry.label)}" at ${entry.inside}`, 'yellow')}`
        );
        break;
      case 'delivery':
        if (!options.verbose) break;
        lines.push(
          `${blank} ${time}  ${writer}${indent}${paint(`-- ${runs.rewrite(entry.message)}`, 'gray')}`
        );
        break;
      case 'note':
        lines.push(
          `${blank} ${time}  ${writer}${indent}${paint(`// ${runs.rewrite(entry.message)}`, 'dim')}`
        );
        break;
      case 'warn':
        lines.push(
          `${blank} ${time}  ${writer}${indent}${paint(`!! ${withRefs(entry.message, index, runs)}`, 'red')}`
        );
        break;
      case 'check':
        lines.push(
          `${blank} ${time}  ${writer}${indent}${paint(
            `${entry.ok ? CHECK : CROSS} check: ${runs.rewrite(entry.name)}`,
            entry.ok ? 'green' : 'red'
          )}`
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
  const paint = painter(options);
  const out: string[] = [];
  const status = result.ok
    ? paint('PASS', 'green', 'bold')
    : paint('FAIL', 'red', 'bold');

  out.push(`${status}  ${paint(result.id, 'bold')}`);
  out.push(`      ${result.name}`);
  if (result.description) out.push(`      ${paint(result.description, 'dim')}`);
  out.push(
    paint(
      `      run=${result.runId || '(none)'} outcome=${result.outcome} ` +
        `events=${result.events.length} deliveries=${result.deliveries} ` +
        `worldCalls=${result.worldCalls} virtual=${formatDuration(result.virtualElapsedMs)} ` +
        `wall=${result.wallMs.toFixed(0)}ms replay=${describeReplay(result)}`,
      'dim'
    )
  );
  // Every run the scenario touched, created or not, labelled the way the
  // trace labels them.
  const candidateIds = [
    ...result.runs.map((r) => r.runId),
    ...result.startHookDecisions.map((d) => d.runId),
  ];
  const runs = buildRunLabels(result.trace, candidateIds);
  if (runs.multi) {
    const status = new Map(result.runs.map((r) => [r.runId, r]));
    const decision = new Map(
      result.startHookDecisions.map((d) => [d.runId, d])
    );
    out.push('');
    for (const [runId, label] of runs.entries()) {
      const run = status.get(runId);
      const d = decision.get(runId);
      const what = run
        ? `${shortName(run.workflowName)} ${run.status}${d ? `, owns "${d.token}"` : ''}`
        : d?.decision === 'rejected'
          ? `refused for "${d.token}" (owner ${runs.rewrite(d.conflictingRunId ?? '?')}), never a run`
          : d?.decision === 'accepted'
            ? `accepted for "${d.token}", never created`
            : 'never a run';
      out.push(paint(`      ${label.padEnd(4)} ${runId}  ${what}`, 'dim'));
    }
  }
  if (result.requests.length > 0) {
    out.push('');
    for (const request of result.requests) {
      const attempts = request.attempts
        .map(
          (a) =>
            `${a.caller}: ${
              a.outcome
                ? runs.rewrite(describeStartOutcome(a.outcome))
                : a.died
                  ? `died (${runs.rewrite(a.died)})`
                  : 'no answer'
            }`
        )
        .join('; ');
      out.push(paint(`      request ${request.request} -> ${attempts}`, 'dim'));
    }
  }

  out.push('');
  out.push(renderTrace(result.trace, { ...options, runIds: candidateIds }));

  const index = buildEventIndex(result.trace);

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
    out.push(paint('      CONSISTENCY VIOLATIONS', 'red', 'bold'));
    for (const v of result.violations) {
      const position = v.eventId
        ? index.position(v.eventId, v.runId)
        : undefined;
      const where = v.runId ? runs.of(v.runId) : undefined;
      const at =
        position !== undefined
          ? ` (at ${where ? `${where} ` : ''}#${position})`
          : where
            ? ` (${where})`
            : '';
      out.push(
        `        ${paint(`[${v.rule}]`, 'red')} ${withRefs(v.message, index, runs, v.runId)}${paint(at, 'dim')}`
      );
    }
  }

  if (result.problems.length > 0) {
    out.push('');
    out.push(paint('      PROBLEMS', 'red', 'bold'));
    for (const p of result.problems) {
      out.push(`        ${withRefs(p, index, runs)}`);
    }
  }

  return out.join('\n');
}

export function renderSummary(
  results: readonly ScenarioResult[],
  options: RenderOptions = {}
): string {
  const paint = painter(options);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const violations = results.reduce((n, r) => n + r.violations.length, 0);
  return [
    '',
    `${results.length} scenario(s): ` +
      `${paint(`${passed} passed`, 'green')}, ` +
      `${paint(`${failed} failed`, failed > 0 ? 'red' : 'dim')}, ` +
      `${paint(`${violations} consistency violation(s)`, violations > 0 ? 'red' : 'dim')}`,
  ].join('\n');
}

export interface MarkdownSummaryOptions {
  /** Label on the fold's visible line. Defaults to `world-sim`. */
  title?: string;
  /**
   * Which world produced these results, as short `key=value` chips above the
   * table, such as `log=append-only`, `fence=off`. A summary that does not
   * say which world it ran in is unreadable next to another one, and the
   * whole point of this book is comparing two runs of it.
   */
  chips?: readonly string[];
  /**
   * Where the full trace was written, mentioned under the table so a reader
   * who needs more than a row knows an artifact exists.
   */
  detailPath?: string;
}

/**
 * The same counts as `renderSummary`, as GitHub-flavoured markdown sized for a
 * PR comment or `$GITHUB_STEP_SUMMARY`.
 *
 * One collapsed `<details>`: a visible line carrying the count and a green or
 * orange dot, and the whole table behind it. Built to be stacked (a CI job
 * plays the book once per world and puts two of these under one heading), so
 * it renders no heading of its own, and nothing above the fold but the count.
 *
 * There is deliberately no list of failures. Six of them are red on purpose,
 * so a comment that leads with the failures leads with the part that is not
 * news, and it grows a wall of text on exactly the PRs that changed nothing.
 * The count is the signal; the names are one click away.
 *
 * Never colored, since ANSI in a markdown file renders as garbage.
 */
export function renderMarkdownSummary(
  results: readonly ScenarioResult[],
  options: MarkdownSummaryOptions = {}
): string {
  const failed = results.filter((r) => !r.ok).length;
  const out: string[] = [];

  // A dot rather than words: `<summary>` is one line of a collapsed comment,
  // and markdown has no color, so this is the only way the two worlds read as
  // different at a glance without being read at all.
  out.push('<details>');
  out.push(
    `<summary>${failed > 0 ? '🟠' : '🟢'} <b>${options.title ?? 'world-sim'}</b>` +
      ` — ${failed} fail of ${results.length} total</summary>`
  );
  // Blank line after `</summary>`, or GitHub renders the table as literal
  // pipes.
  out.push('');

  if (options.chips && options.chips.length > 0) {
    out.push(options.chips.map((c) => `\`${c}\``).join(' · '));
    out.push('');
  }

  out.push('| scenario | outcome | events | virt | replay | violations |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    out.push(
      `| ${r.ok ? '✅' : '❌'} \`${r.id}\` | ${r.outcome} | ${r.events.length} | ` +
        `${formatDuration(r.virtualElapsedMs)} | ${describeReplay(r)} | ` +
        `${r.violations.length} |`
    );
  }

  if (options.detailPath) {
    out.push('');
    out.push(`Full trace: \`${options.detailPath}\``);
  }
  out.push('');
  out.push('</details>');
  out.push('');
  return out.join('\n');
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
