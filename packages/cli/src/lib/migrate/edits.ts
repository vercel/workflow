/**
 * Source-preserving text edits for codemods.
 *
 * Each edit replaces a `[start, end)` range of the original text with the
 * string its `render()` returns. An edit may render ranges of the original
 * text itself (for example the body of a closure it moves), and the edits
 * nested in that range are applied there, so an edit never needs to know what
 * other edits sit inside it. Text outside every edit is copied unchanged,
 * which keeps formatting and comments the codemod did not touch.
 */
export interface Edit {
  start: number;
  end: number;
  render: () => string;
}

export class EditSet {
  private readonly edits: Edit[] = [];

  constructor(readonly text: string) {}

  add(start: number, end: number, render: string | (() => string)): Edit {
    const edit: Edit = {
      start,
      end,
      render: typeof render === 'string' ? () => render : render,
    };
    this.edits.push(edit);
    return edit;
  }

  /** Insert text at `pos` without replacing anything. */
  insert(pos: number, text: string | (() => string)): Edit {
    return this.add(pos, pos, text);
  }

  get size(): number {
    return this.edits.length;
  }

  /**
   * Render `[start, end)` of the original text with every edit inside it
   * applied. `self` is the edit doing the rendering, which is skipped so an
   * edit can render its own range without recursing into itself.
   */
  render(start: number, end: number, self?: Edit): string {
    const inside = this.edits
      .filter(
        (e) =>
          e !== self &&
          e.start >= start &&
          e.end <= end &&
          // A zero-width insert at the very end of the range belongs to the
          // text after it, unless the range itself is empty.
          !(e.start === e.end && e.start === end && end > start)
      )
      // Inserts first, then outermost first, so containment is easy to test.
      .sort(
        (a, b) =>
          a.start - b.start ||
          Number(a.start !== a.end) - Number(b.start !== b.end) ||
          b.end - a.end
      );

    let out = '';
    let cursor = start;
    let coveredUntil = start;
    for (const edit of inside) {
      if (edit.start < coveredUntil) {
        if (edit.end <= coveredUntil) continue; // nested in an earlier edit
        throw new Error(
          `Overlapping edits at ${edit.start}-${edit.end} (covered until ${coveredUntil})`
        );
      }
      out += this.text.slice(cursor, edit.start);
      out += edit.render();
      cursor = edit.end;
      coveredUntil = edit.end;
    }
    out += this.text.slice(cursor, end);
    return out;
  }

  apply(): string {
    return this.render(0, this.text.length);
  }
}

/** The whitespace at the start of the line that contains `pos`. */
export function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart));
  return match ? match[0] : '';
}

/** Offset of the start of the line containing `pos`. */
export function lineStartOf(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

/** 1-based line number of `pos`. */
export function lineOf(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Detect the file's indentation unit from its least-indented code line, so
 * generated code matches what is already there.
 */
export function detectIndentUnit(text: string): string {
  let smallest: string | undefined;
  for (const line of text.split('\n')) {
    const match = /^([ \t]+)[^\s*]/.exec(line);
    if (!match) continue;
    if (match[1].startsWith('\t')) return '\t';
    if (smallest === undefined || match[1].length < smallest.length) {
      smallest = match[1];
    }
  }
  return smallest ?? '  ';
}
