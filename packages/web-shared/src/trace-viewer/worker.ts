import type {
  RootNode,
  Span,
  TraceNode,
  VisibleSpan,
  WorkerRequest,
  WorkerResponse,
} from './types';
import { addToRow } from './util/tree';

// The most recent requestId
let requestId = 0;

self.addEventListener('message', (event) => {
  const data = event.data as WorkerRequest;
  requestId = Math.max(requestId, data.requestId || 0);

  switch (data.type) {
    case 'calculateSpanPositions':
      calculateSpanPositions(data.root);
      break;
    case 'filterSpans':
      filterSpans(data.root, data.filter);
      break;
    default:
      break;
  }
});

const positionHelper = (node: TraceNode, pending: VisibleSpan[]): void => {
  if ('parent' in node) {
    const n = node as VisibleSpan;
    n.row = -1;
    n.isVisible = true;
    pending.push(n);
  }

  const sortedChildren = node.children
    .slice()
    .sort((a, b) => a.startTime - b.startTime || b.duration - a.duration);
  for (const child of sortedChildren) {
    positionHelper(child, pending);
  }
};

const calculateSpanPositions = (root: RootNode): void => {
  const responseId = requestId;
  const placed: VisibleSpan[][] = [];
  const pending: VisibleSpan[] = [];

  positionHelper(root, pending);

  let lastFlushT = Date.now() - 10;
  let lastFlushC = -64;
  let count = 0;
  const flush = (): void => {
    for (const row of placed) {
      row.sort((a, b) => a.startTime - b.startTime);
    }
    const message: WorkerResponse = {
      requestId: responseId,
      type: 'setRowsResult',
      rows: placed,
      isEnd: !pending.length,
    };
    postMessage(message);
    lastFlushT = Date.now();
    lastFlushC = count;
  };

  while (true) {
    const node = pending.shift();
    if (!node) {
      flush();
      return;
    }
    addToRow(placed, node, 0.001);
    ++count;
    if (Date.now() - lastFlushT >= 15 || count - lastFlushC >= 256) {
      flush();
    }
  }
};

const ATTR_FILTER_REGEX = /(?<=^|\s)(?<pair>(?<key>[\w.]+):(?<value>\S*))/g;

const filterSpans = (root: RootNode, filter: string): void => {
  const responseId = requestId;

  const matches = new Set<string>();

  const name = filter
    .replace(ATTR_FILTER_REGEX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const attrs: [string, string][] = [];
  for (const m of filter.matchAll(ATTR_FILTER_REGEX)) {
    const { key = '', value = '' } = m.groups || {};
    attrs.push([key, value.toLocaleLowerCase()]);
  }

  const match = (span: Span): boolean => {
    if (!span.name.toLocaleLowerCase().includes(name)) return false;
    // TODO: support resource attribute filtering
    return attrs.every(([key, value]) => {
      const v = span.attributes[key];
      if (!v) return false;
      return String(v).toLocaleLowerCase().includes(value);
    });
  };

  const helper = (node: TraceNode): void => {
    for (const child of node.children) {
      if (match(child.span)) {
        matches.add(child.span.spanId);
      }
      helper(child);
    }
  };
  helper(root);

  const message: WorkerResponse = {
    requestId: responseId,
    type: 'updateHighlight',
    matches,
  };
  postMessage(message);
};
