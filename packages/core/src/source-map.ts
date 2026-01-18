import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';

/**
 * Remaps an error stack trace using inline source maps to show original source locations.
 *
 * @param stack - The error stack trace to remap
 * @param filename - The workflow filename to match in stack frames
 * @param workflowCode - The workflow bundle code containing inline source maps
 * @returns The remapped stack trace with original source locations
 */
export function remapErrorStack(
  stack: string,
  filename: string,
  workflowCode: string
): string {
  // Extract inline source map from workflow code
  const sourceMapMatch = workflowCode.match(
    /\/\/# sourceMappingURL=data:application\/json;base64,(.+)/
  );
  if (!sourceMapMatch) {
    return stack; // No source map found
  }

  try {
    const base64 = sourceMapMatch[1];
    const sourceMapJson = Buffer.from(base64, 'base64').toString('utf-8');
    const sourceMapData = JSON.parse(sourceMapJson);

    // Use TraceMap (pure JS, no WASM required)
    const tracer = new TraceMap(sourceMapData);

    // Parse and remap each line in the stack trace
    const lines = stack.split('\n');
    const remappedLines = lines.map((line) => {
      // Match stack frames: "at functionName (filename:line:column)" or "at filename:line:column"
      const frameMatch = line.match(
        /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/
      );
      if (!frameMatch) {
        return line; // Not a stack frame, return as-is
      }

      const [, functionName, file, lineStr, colStr] = frameMatch;

      // Only remap frames from our workflow file
      if (!file.includes(filename)) {
        return line;
      }

      const lineNumber = parseInt(lineStr, 10);
      const columnNumber = parseInt(colStr, 10);

      // Map to original source position
      const original = originalPositionFor(tracer, {
        line: lineNumber,
        column: columnNumber,
      });

      if (original.source && original.line !== null) {
        const func = functionName || original.name || 'anonymous';
        const col = original.column !== null ? original.column : columnNumber;
        return `    at ${func} (${original.source}:${original.line}:${col})`;
      }

      return line; // Couldn't map, return original
    });

    return remappedLines.join('\n');
  } catch (e) {
    // If source map processing fails, return original stack
    return stack;
  }
}
