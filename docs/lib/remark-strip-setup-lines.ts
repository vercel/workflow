/**
 * Remove `// @setup` lines from fenced code blocks.
 *
 * Docs samples are type-checked as written (packages/docs-typecheck), so an
 * example that calls a step it does not define declares it inline:
 *
 *   declare function processRecord(record: Record): Promise<string>; // @setup
 *
 * Those declarations exist for the type checker, not the reader. This plugin
 * drops every line carrying the marker (and any blank lines it leaves at the
 * top of the block) before rendering, so neither the highlighted page nor the
 * processed-markdown export (llms.txt, `.md` routes, copy-page) shows them.
 *
 * The marker was originally hidden client-side in a custom CodeBlock
 * (#846); that component did not survive the geistdocs migration (#2222),
 * which is why this runs in the remark stage instead: one pass, server-side,
 * covering every consumer of the processed content.
 */
const SETUP_LINE = /\/\/\s*@setup\b/;
// A line that begins a statement. Used to find the start of a multi-line
// declaration whose marker sits on its last line:
//
//   declare function subscribeInbox<T>(
//     source: AsyncIterable<T>
//   ): { drain: () => T[] }; // @setup
const STATEMENT_START =
  /^(declare|type|interface|import|export|const|let|var|function|class|enum|abstract)\b/;

function stripSetupLines(value: string): string {
  if (!SETUP_LINE.test(value)) return value;
  const lines = value.split('\n');
  const drop = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!SETUP_LINE.test(lines[i])) continue;
    drop[i] = true;
    // Walk back to the line that opened this statement, so a marker on the
    // closing line of a multi-line declaration removes all of it. Stop at a
    // blank line or another dropped line: the statement cannot span those.
    let j = i;
    while (
      j > 0 &&
      !STATEMENT_START.test(lines[j].trim()) &&
      lines[j - 1].trim() !== '' &&
      !drop[j - 1]
    ) {
      j--;
      drop[j] = true;
    }
  }
  const kept = lines.filter((_, i) => !drop[i]);
  // Drop blank lines left at the top of the block (typically the separator
  // between the declarations and the example proper), and collapse any run
  // of blank lines a removed declaration left in the middle.
  let start = 0;
  while (start < kept.length && kept[start].trim() === '') start++;
  const out: string[] = [];
  for (const line of kept.slice(start)) {
    if (
      line.trim() === '' &&
      out.length > 0 &&
      out[out.length - 1].trim() === ''
    ) {
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Minimal structural view of an mdast tree; avoids depending on @types/mdast. */
type Node = { type: string; value?: string; children?: Node[] };

function walk(node: Node): void {
  if (node.type === 'code' && typeof node.value === 'string') {
    node.value = stripSetupLines(node.value);
  }
  if (node.children) for (const child of node.children) walk(child);
}

export function remarkStripSetupLines() {
  return (tree: Node) => {
    walk(tree);
  };
}

export { stripSetupLines };
