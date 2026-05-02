import * as Ansi from '@workflow/errors/ansi';

/**
 * A `docs:` line URL. The leading protocol is part of the type so call sites
 * can't accidentally pass a protocol-relative or bare path.
 */
export type DocsUrl = `https://${string}`;

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/**
 * Structured data for a framed error. The base class takes this and renders
 * it to plain text (for `.message` / `.stack` / structured logs) or to an
 * ANSI-framed string (for terminal display via `util.inspect` / `toString`).
 *
 * Keeping the pieces structured means we never have to strip ANSI back out
 * once it's in the message — we just don't put it there in the first place.
 */
export interface FramedContent {
  /** Headline. `{ code: 'foo()' }` segments render as backticked inline code. */
  readonly title: readonly Segment[];
  /** One framed branch per entry. The last uses `╰▶`, others use `├▶`. */
  readonly details: readonly Detail[];
}

export type Segment =
  | { readonly text: string }
  | { readonly code: string }
  | { readonly dim: string };

export type Detail =
  | { readonly type: 'plain'; readonly segments: readonly Segment[] }
  | { readonly type: 'docs'; readonly url: DocsUrl };

function renderSegmentPlain(s: Segment): string {
  if ('code' in s) return `\`${s.code}\``;
  if ('dim' in s) return s.dim;
  return s.text;
}

function renderSegmentPretty(s: Segment): string {
  if ('code' in s) return Ansi.code(s.code);
  if ('dim' in s) return Ansi.dim(s.dim);
  return s.text;
}

function renderDetailPlain(d: Detail): string {
  if (d.type === 'docs') return `docs: ${d.url}`;
  return d.segments.map(renderSegmentPlain).join('');
}

function renderDetailPretty(d: Detail): string {
  if (d.type === 'docs') return Ansi.docs(d.url);
  return d.segments.map(renderSegmentPretty).join('');
}

export function renderPlain(c: FramedContent): string {
  // Mimic `Ansi.frame` structure so `.message` is still readable in logs
  // even without the color.
  const title = c.title.map(renderSegmentPlain).join('');
  const lines = [title];
  c.details.forEach((detail, index) => {
    const isLast = index === c.details.length - 1;
    const first = isLast ? '╰▶ ' : '├▶ ';
    const cont = isLast ? '   ' : '│  ';
    const raw = renderDetailPlain(detail).split('\n');
    raw.forEach((line, i) => lines.push(`${i === 0 ? first : cont}${line}`));
  });
  return lines.join('\n');
}

export function renderPretty(c: FramedContent): string {
  const title = c.title.map(renderSegmentPretty).join('');
  return Ansi.frame(title, c.details.map(renderDetailPretty));
}

/**
 * Base class for structured context-violation errors.
 *
 * Design notes:
 *
 * - `.message` is **plain text** (no ANSI escape bytes). Structured logs,
 *   log drains, CBOR-serialized event data, and anything else that reads
 *   `err.message` / `err.stack` as a string gets clean output — no mojibake
 *   in JSON, no `\x1B[...m` noise in Vercel logs.
 *
 * - The ANSI-framed version is rendered **lazily** via `toString()` and
 *   `[util.inspect.custom]`. When the error is thrown and Node prints it
 *   via `util.inspect`, the user sees the colored, framed box. When it's
 *   attached to a structured log field, the consumer sees plain text.
 *
 * - `fatal = true` marks these as non-retryable. Calling `createHook()`
 *   from a step function will never succeed no matter how many retries —
 *   burning attempts just produces duplicated log output. The runtime's
 *   `FatalError.is(err)` gate recognizes any error with `fatal: true`.
 */
export abstract class ContextViolationError extends Error {
  /** Non-retryable — see class doc. */
  readonly fatal = true;

  readonly #content: FramedContent;

  constructor(content: FramedContent) {
    super(renderPlain(content));
    this.#content = content;
  }

  /**
   * `console.log(err)` and most Node internals route through `util.inspect`,
   * which respects this symbol. Returning a custom string here means the
   * thrown error prints as a pretty frame in the terminal while `.message`
   * and `.stack` stay plain.
   */
  [INSPECT_CUSTOM](): string {
    const pretty = renderPretty(this.#content);
    // `stack` starts with `${name}: ${message}\n    at ...`. Our message is
    // multi-line (`title\n╰▶ docs: …`), so slicing only the first line glues
    // the framed-detail tail of the message onto the prepended pretty form
    // and renders every detail line twice. Slice past *all* message lines.
    const messageLineCount = this.message.split('\n').length;
    const tail = (this.stack ?? '')
      .split('\n')
      .slice(messageLineCount)
      .join('\n');
    return tail
      ? `${this.name}: ${pretty}\n${tail}`
      : `${this.name}: ${pretty}`;
  }

  toString(): string {
    return `${this.name}: ${renderPretty(this.#content)}`;
  }
}

/**
 * Thrown when an API that must run inside a workflow function is called
 * from outside a workflow context (e.g. from a step function or from
 * regular application code).
 */
export class NotInWorkflowContextError extends ContextViolationError {
  name = 'NotInWorkflowContextError';

  constructor(functionName: string, docsUrl: DocsUrl) {
    super({
      title: [
        { code: functionName },
        { text: ' can only be called inside a workflow function' },
      ],
      details: [{ type: 'docs', url: docsUrl }],
    });
  }
}

/**
 * Thrown when an API that must run inside a step function is called from
 * outside a step context.
 */
export class NotInStepContextError extends ContextViolationError {
  name = 'NotInStepContextError';

  constructor(functionName: string, docsUrl: DocsUrl) {
    super({
      title: [
        { code: functionName },
        { text: ' can only be called inside a step function' },
      ],
      details: [{ type: 'docs', url: docsUrl }],
    });
  }
}

/**
 * Thrown when an API that must run inside either a workflow or step function
 * is called from regular application code.
 */
export class NotInWorkflowOrStepContextError extends ContextViolationError {
  name = 'NotInWorkflowOrStepContextError';

  constructor(functionName: string, docsUrl: DocsUrl) {
    super({
      title: [
        { code: functionName },
        { text: ' can only be called inside a workflow or step function' },
      ],
      details: [{ type: 'docs', url: docsUrl }],
    });
  }
}
