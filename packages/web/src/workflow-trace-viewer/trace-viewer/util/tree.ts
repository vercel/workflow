import type {
  RootNode,
  Span,
  SpanNode,
  SpanNodeEvent,
  Trace,
  TraceNode,
  VisibleSpan,
} from '../types';
import { getHighResInMs, getMsInHighRes } from './timing';

export const parseTrace = (
  trace: Trace
): { root: RootNode; map: Record<string, SpanNode> } => {
  const { spans } = trace;
  const root: RootNode = {
    startTime: 0,
    endTime: 0,
    duration: 0,
    depth: 0,
    children: [],
  };
  const map: Record<string, SpanNode> = {};

  const resourceIndices = new Map<string, number>();
  const getResourceIndex = (resource: string): number => {
    const existing = resourceIndices.get(resource);
    if (existing) return existing;

    const index = resourceIndices.size + 1;
    resourceIndices.set(resource, index);
    return index;
  };

  let hasUserSpans = false;
  for (const span of spans) {
    const startTime = getHighResInMs(span.startTime);
    const endTime = getHighResInMs(span.endTime);
    const duration = getHighResInMs(span.duration);
    if (endTime > root.endTime) {
      root.endTime = endTime;
      root.duration = endTime - root.startTime;
    }
    if (root.startTime === 0 || startTime < root.startTime) {
      root.startTime = startTime;
      root.duration = root.endTime - startTime;
    }
    const isVercelResource = span.resource.startsWith('vercel.');
    if (!isVercelResource) {
      hasUserSpans = true;
    }

    const isVercel =
      isVercelResource &&
      (span.resource !== 'vercel.serverless-runtime' ||
        !('http.method' in span.attributes));

    const resourceIndex = isVercel ? 0 : getResourceIndex(span.resource);

    let label: string | undefined;
    if (isVercel) {
      label = `▲ ${span.name}`;
    }
    map[span.spanId] = {
      parent: null as unknown as SpanNode,
      startTime,
      endTime,
      duration,
      span,
      depth: 0,
      label,
      events: parseEvents(span),
      isVercel,
      children: [],
      resourceIndex,
    };
  }

  const addTo = (node: SpanNode, parentId?: string): void => {
    let parent: TraceNode | undefined;
    if (parentId) {
      parent = map[parentId];
      if (!parent) {
        if (process.env.NODE_ENV === 'development') {
          console.warn('Could not find parent span with spanId: %s', parentId);
        }
        parent = root;
      }
    } else {
      parent = root;
    }
    node.parent = parent;
    parent.children.push(node);
  };

  const updateDepth = (node: TraceNode): void => {
    if ('parent' in node) {
      node.depth = node.parent.depth + 1;
    }
    for (const child of node.children) {
      updateDepth(child);
    }
  };

  let hintIdCounter = 1;
  const addInstrumentationHint = (node: TraceNode, name: string): boolean => {
    if ('parent' in node) {
      if (node.span.name === name) {
        let waitUntilStart = node.endTime;
        // Detect the parent that's most likely to be at the bottom of the UI
        const findParent = (span: SpanNode): SpanNode => {
          if (!span.children.length) {
            if (span.span.name === 'waitUntil') {
              waitUntilStart = span.startTime;
              return span.parent as SpanNode;
            }
            return span;
          }

          return (
            span.children
              .map(findParent)
              .sort((a, b) => a.duration - b.duration)[0] || span
          );
        };
        const parent = findParent(node);

        const spanId = `instrumentation-hint-${hintIdCounter++}`;
        const offset = node.duration * 0.05;
        const startTime = node.startTime + offset;
        const endTime = Math.max(
          startTime + offset,
          Math.min(waitUntilStart - node.duration * 0.01, node.endTime - offset)
        );
        const duration = endTime - startTime;
        const hint: SpanNode = {
          parent,
          startTime,
          endTime,
          duration,
          span: {
            spanId,
            name: 'Add your spans here',
            resource: '',
            kind: 0,
            library: {
              name: '',
            },
            status: {
              code: 200,
            },
            traceFlags: 0,
            attributes: {},
            links: [],
            events: [],
            startTime: getMsInHighRes(startTime),
            endTime: getMsInHighRes(endTime),
            duration: getMsInHighRes(duration),
          },
          depth: node.depth + 1,
          isVercel: false,
          isInstrumentationHint: true,
          children: [],
          resourceIndex: 1,
        };
        parent.children.push(hint);
        map[spanId] = hint;
        return true;
      }
    }
    for (const child of node.children) {
      if (addInstrumentationHint(child, name)) return true;
    }
    return false;
  };

  // Create tree by matching nodes to their parents
  for (const node of Object.values(map)) {
    addTo(node, node.span.parentSpanId);
  }

  // Adjust depth of each node now that the tree is fully constructed
  updateDepth(root);

  // Add hints in the places where user spans would appear
  if (!hasUserSpans) {
    for (const name of [
      'Invoke Function',
      'Invoke Middleware',
      'Vercel Runtime',
    ]) {
      if (addInstrumentationHint(root, name)) break;
    }
  }

  return { root, map };
};

const parseEvents = (span: Span): SpanNodeEvent[] | undefined => {
  if (!span.events.length) return;

  const keyPrefix = `${span.spanId}:ev`;

  return span.events
    .map<SpanNodeEvent>((event, index) => ({
      key: `${keyPrefix}${index}`,
      timestamp: getHighResInMs(event.timestamp),
      event,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
};

/**
 * Adds a node to a row and attempts to find the ideal placement
 * within an existing row, creating a new one if necessary
 */
export const addToRow = (
  placed: VisibleSpan[][],
  node: VisibleSpan,
  precision: number
): void => {
  const parent = node.parent as VisibleSpan | undefined;
  for (let y = (parent?.row || -1) + 1; ; ++y) {
    let row = placed[y];
    if (!row) {
      row = [];
      placed.push(row);
    } else if (
      !row.every(
        ({ startTime, endTime }) =>
          startTime + precision > node.endTime ||
          endTime - precision < node.startTime
      )
    ) {
      continue;
    }
    node.row = y;
    row.push(node);
    break;
  }
};

export const spanVisiblityHelper = (
  node: TraceNode,
  scale: number,
  visible: VisibleSpan[]
): void => {
  if ('parent' in node) {
    const n = node as VisibleSpan;
    n.row = -1;
    // Always make spans visible regardless of width
    n.isVisible = true;
    n.isHovered = false;
    if (!n.isVisible) return;

    visible.push(n);
  }

  for (const child of node.children) {
    spanVisiblityHelper(child, scale, visible);
  }
};

export const adjustSpanVisibility = (
  span: VisibleSpan,
  _scale: number
): boolean => {
  // Always make spans visible regardless of width
  span.isVisible = true;
  span.isHovered = false;

  return span.isVisible;
};
