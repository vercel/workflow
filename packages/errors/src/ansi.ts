// Imported from a sibling module rather than `chalk` proper so this file
// (and everything that statically imports it — including the workflow-VM
// reachable `context-violation-error.ts`) doesn't pull in chalk's
// `supports-color` / `require('os')` chain. See `./internal-chalk.ts`
// for the full rationale and the test mock that swaps it out.
import chalk from './internal-chalk.js';

/**
 * Helpers for composing structured, human-friendly error messages.
 *
 * The goal is to make errors *actionable*: say what happened, explain why,
 * and give the user a way out. Rendering uses ANSI colors when the terminal
 * supports them (chalk auto-detects) and falls back to plain text elsewhere.
 *
 * Typical usage:
 *
 * ```ts
 * throw new Error(
 *   Ansi.frame(
 *     `${Ansi.code(fnName)} can only be called inside a workflow function`,
 *     [Ansi.note(`Read more about creating hooks: https://...`)]
 *   )
 * );
 * ```
 *
 * Renders as:
 *
 * ```
 * `createHook()` can only be called inside a workflow function
 * ╰▶ note: Read more about creating hooks: https://...
 * ```
 */

const styles = {
  info: chalk.blue,
  help: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

/** A "help:" line — use for the primary suggested fix. */
export function help(messages: string | string[]): string {
  const message = Array.isArray(messages) ? messages.join('\n') : messages;
  return styles.help(`${chalk.bold('help:')} ${message}`);
}

/** A "hint:" line — use for supplementary context or suggestions. */
export function hint(messages: string | string[]): string {
  const message = Array.isArray(messages) ? messages.join('\n') : messages;
  return styles.info(`${chalk.bold('hint:')} ${message}`);
}

/** A "note:" line — use for informational context. */
export function note(messages: string | string[]): string {
  const message = Array.isArray(messages) ? messages.join('\n') : messages;
  return styles.info(`${chalk.bold('note:')} ${message}`);
}

/** A "docs:" line — use for a single documentation URL. */
export function docs(url: string): string {
  return styles.info(`${chalk.bold('docs:')} ${url}`);
}

/** Render an inline code token (italicized, dim backticks). */
export function code(str: string): string {
  return chalk.italic(`${chalk.dim('`')}${str}${chalk.dim('`')}`);
}

/** Apply dim styling to a string (used for de-emphasizing separators). */
export function dim(str: string): string {
  return chalk.dim(str);
}

/** Bold styling (used for emphasizing class names in headers). */
export function bold(str: string): string {
  return chalk.bold(str);
}

/** Red styling (used for the user-error attribution badge). */
export function red(str: string): string {
  return chalk.red(str);
}

/** Magenta styling (used for the SDK-error attribution badge). */
export function magenta(str: string): string {
  return chalk.magenta(str);
}

/**
 * Frame a title with one or more continuation lines, drawn with
 * box-drawing characters. The last content uses `╰▶`, others use `├▶`.
 * Multi-line contents are indented under their branch.
 *
 * @example
 * frame('Something went wrong', ['why it happened', hint('how to fix it')])
 * // Something went wrong
 * // ├▶ why it happened
 * // ╰▶ hint: how to fix it
 */
export function frame(title: string, contents: string[]): string {
  const result = [title];

  contents.forEach((content, index) => {
    const lines = content.split('\n');
    const isLastContent = index === contents.length - 1;

    const firstLinePrefix = isLastContent ? '╰▶ ' : '├▶ ';
    const continuationPrefix = isLastContent ? '   ' : '│  ';

    const framedLines = lines.map((line, lineIndex) => {
      const prefix = lineIndex === 0 ? firstLinePrefix : continuationPrefix;
      return `${prefix}${line}`;
    });

    result.push(...framedLines);
  });

  return result.join('\n');
}

interface Explain {
  text: string;
  explain: string;
  /** adds ansi coloring */
  color?: (s: string) => string;
}

type Explainish =
  | Explain
  | [text: string, explain: string, opts?: { color: Explain['color'] }];

type Marker = {
  startCol: number;
  endCol: number;
  explain: string;
  color?: (s: string) => string;
};

const identity = (s: string) => s;

function getMarkerMidpoint(marker: Marker): number {
  const textLen = marker.endCol - marker.startCol;
  return marker.startCol + Math.floor(textLen / 2);
}

function buildUnderline(markers: Marker[]): string {
  const parts: string[] = [];
  let pos = 0;
  for (const marker of markers) {
    // Treat zero-length markers as length 1 so we always emit a `┬` anchor
    // for the explanation line and avoid a negative `String.repeat` count.
    const textLen = Math.max(1, marker.endCol - marker.startCol);
    const midPoint = Math.floor(textLen / 2);

    if (marker.startCol > pos) {
      parts.push(' '.repeat(marker.startCol - pos));
      pos = marker.startCol;
    }
    const leftFill = '─'.repeat(midPoint);
    const rightFill = '─'.repeat(Math.max(0, textLen - midPoint - 1));
    const segment = `${leftFill}┬${rightFill}`;
    const colorFn = marker.color ?? identity;
    parts.push(colorFn(segment));
    pos += textLen;
  }
  return parts.join('');
}

function buildExplanationLine(
  marker: Marker,
  midCol: number,
  remainingMids: number[],
  isOnlyMarker: boolean
): string {
  let line = '╰';
  let pos = midCol + 1;

  for (const nextMid of remainingMids) {
    while (pos < nextMid) {
      line += '─';
      pos++;
    }
    line += '┼';
    pos++;
  }

  const arrow = isOnlyMarker ? '▶ ' : '─▶ ';
  line += arrow + marker.explain;

  const colorFn = marker.color ?? identity;
  return ' '.repeat(midCol) + colorFn(line);
}

/**
 * Tagged template for underlining tokens in a source string and annotating
 * them with explanations. Useful for pointing out offending tokens in
 * user-authored code.
 *
 * @example
 * inline`function ${{ text: 'hello', explain: 'name not allowed' }}() {
 *   return 666
 * }`
 * // function hello() {
 * //          ──┬──
 * //            ╰▶ name not allowed
 * //   return 666
 * // }
 */
export function inline(
  text: TemplateStringsArray,
  ...values: Explainish[]
): string {
  const resultLines: string[] = [];
  let currentLine = '';
  let currentLineVisualLen = 0;
  let pendingMarkers: Marker[] = [];

  const flushLine = () => {
    resultLines.push(currentLine);
    if (pendingMarkers.length === 0) {
      currentLine = '';
      currentLineVisualLen = 0;
      return;
    }

    const markerMids = pendingMarkers.map(getMarkerMidpoint);

    resultLines.push(buildUnderline(pendingMarkers));

    for (let i = 0; i < pendingMarkers.length; i++) {
      const line = buildExplanationLine(
        pendingMarkers[i],
        markerMids[i],
        markerMids.slice(i + 1),
        pendingMarkers.length === 1
      );
      resultLines.push(line);
    }

    pendingMarkers = [];
    currentLine = '';
    currentLineVisualLen = 0;
  };

  for (let i = 0; i < text.length; i++) {
    const segment = text[i];
    const lines = segment.split('\n');

    for (let j = 0; j < lines.length; j++) {
      if (j > 0) {
        flushLine();
      }
      currentLine += lines[j];
      currentLineVisualLen += lines[j].length;
    }

    if (i < values.length) {
      const val = values[i];
      const value: Explain = !Array.isArray(val)
        ? val
        : { text: val[0], explain: val[1], ...val[2] };
      const startCol = currentLineVisualLen;
      const colorFn = value.color ?? ((s: string) => s);
      currentLine += colorFn(value.text);
      currentLineVisualLen += value.text.length;
      const endCol = currentLineVisualLen;
      pendingMarkers.push({
        startCol,
        endCol,
        explain: value.explain,
        color: value.color,
      });
    }
  }

  if (currentLine || pendingMarkers.length > 0) {
    flushLine();
  }

  return resultLines.join('\n');
}
