import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';

function isBase64Char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f ||
    code === 0x3d
  );
}

function extractInlineSourceMapBase64(source: string): string | undefined {
  const sourceMapPrefix = '//# sourceMappingURL=data:application/json';
  const base64Marker = ';base64,';
  let scanFrom = 0;

  while (scanFrom < source.length) {
    const prefixIdx = source.indexOf(sourceMapPrefix, scanFrom);
    if (prefixIdx === -1) return undefined;

    const base64Start = source.indexOf(
      base64Marker,
      prefixIdx + sourceMapPrefix.length
    );
    if (base64Start === -1) {
      scanFrom = prefixIdx + sourceMapPrefix.length;
      continue;
    }

    const commaBefore = source.indexOf(',', prefixIdx);
    if (commaBefore !== -1 && commaBefore < base64Start) {
      scanFrom = base64Start + base64Marker.length;
      continue;
    }

    const valueStart = base64Start + base64Marker.length;
    let valueEnd = valueStart;
    while (valueEnd < source.length) {
      if (!isBase64Char(source.charCodeAt(valueEnd))) {
        break;
      }
      valueEnd++;
    }

    if (valueEnd > valueStart) {
      return source.slice(valueStart, valueEnd);
    }
    scanFrom = valueEnd;
  }
}

/**
 * Memoized `TraceMap | null` per workflow bundle. `null` records "this bundle
 * has no usable inline source map" so repeated failures don't rescan the whole
 * (potentially multi-MB) bundle string or re-parse the map. This matters most
 * in production, where source maps are off by default: the first failure scans
 * once and caches `null`, every later failure is O(1).
 *
 * Keyed by the bundle `code`. Insertion-ordered LRU capped at `MAX_TRACERS`,
 * mirroring `vm/script-cache.ts`: production serves a single build-time bundle
 * literal for the process lifetime, while dev/watch produces a new bundle
 * string per edit — the bound keeps the few most-recent ones and evicts the
 * rest instead of pinning every historical version.
 */
const tracerCache = new Map<string, TraceMap | null>();
const MAX_TRACERS = 8;

function getTraceMapForCode(workflowCode: string): TraceMap | null {
  const cached = tracerCache.get(workflowCode);
  if (cached !== undefined) {
    // Move to most-recently-used position (end of insertion order).
    tracerCache.delete(workflowCode);
    tracerCache.set(workflowCode, cached);
    return cached;
  }

  let tracer: TraceMap | null = null;
  const base64 = extractInlineSourceMapBase64(workflowCode);
  if (base64) {
    try {
      const sourceMapJson = Buffer.from(base64, 'base64').toString('utf-8');
      const sourceMapData = JSON.parse(sourceMapJson);
      // Use TraceMap (pure JS, no WASM required)
      tracer = new TraceMap(sourceMapData);
    } catch {
      // Malformed inline map — treat as absent so we don't retry parsing it.
      tracer = null;
    }
  }

  tracerCache.set(workflowCode, tracer);
  // Evict the least-recently-used entries when over the cap. New entries are
  // appended at the end, so the oldest live at the front.
  while (tracerCache.size > MAX_TRACERS) {
    const oldest = tracerCache.keys().next().value;
    if (oldest === undefined) break;
    tracerCache.delete(oldest);
  }
  return tracer;
}

/**
 * Remaps an error stack trace using inline source maps to show original source locations.
 *
 * Degrades gracefully when the bundle has no inline source map (e.g. production
 * builds, where maps are off by default): the original stack is returned
 * unchanged. A cheap `filename` presence check skips all work when no frame
 * references the workflow file, and parsed source maps are memoized per bundle.
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
  // Nothing to remap if no frame references the workflow file. Avoids touching
  // the (large) bundle string entirely for errors thrown elsewhere.
  if (!stack.includes(filename)) {
    return stack;
  }

  const tracer = getTraceMapForCode(workflowCode);
  if (!tracer) {
    return stack; // No source map found
  }

  try {
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
  } catch {
    // If source map processing fails, return original stack
    return stack;
  }
}
