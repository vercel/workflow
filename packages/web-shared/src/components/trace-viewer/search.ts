import type { Span } from './types';

const ATTR_FILTER_REGEX = /(?:^|\s)(?<pair>(?<key>[\w.]+):(?<value>\S*))/g;

export interface SpanAttributeFilter {
  key: string;
  value: string;
}

export interface ParsedSpanSearchQuery {
  text: string;
  attributes: SpanAttributeFilter[];
}

export interface SpanSearchResult {
  isActive: boolean;
  matchedSpanIds: Set<string>;
  matchingSpans: Span[];
  query: ParsedSpanSearchQuery;
}

export function parseSpanSearchQuery(rawQuery: string): ParsedSpanSearchQuery {
  const attributes: SpanAttributeFilter[] = [];
  for (const match of rawQuery.matchAll(ATTR_FILTER_REGEX)) {
    const key = match.groups?.key?.trim();
    if (!key) continue;
    attributes.push({
      key,
      value: (match.groups?.value ?? '').toLocaleLowerCase(),
    });
  }

  const text = rawQuery
    .replace(ATTR_FILTER_REGEX, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLocaleLowerCase();

  return { text, attributes };
}

export function isSpanDimmedBySearch(
  spanId: string,
  result: SpanSearchResult
): boolean {
  return result.isActive && !result.matchedSpanIds.has(spanId);
}

export function searchSpans(spans: Span[], rawQuery: string): SpanSearchResult {
  const query = parseSpanSearchQuery(rawQuery);
  const isActive = Boolean(query.text || query.attributes.length);
  const matchingSpans = isActive
    ? spans.filter((span) => spanMatchesQuery(span, query))
    : spans;

  return {
    isActive,
    matchedSpanIds: new Set(matchingSpans.map((span) => span.spanId)),
    matchingSpans,
    query,
  };
}

function spanMatchesQuery(span: Span, query: ParsedSpanSearchQuery): boolean {
  if (query.text && !spanMatchesText(span, query.text)) {
    return false;
  }

  return query.attributes.every(({ key, value }) =>
    spanMatchesAttribute(span, key, value)
  );
}

function spanMatchesText(span: Span, text: string): boolean {
  return [
    span.name,
    span.spanId,
    span.resource,
    span.library.name,
    span.library.version,
  ]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => value.toLocaleLowerCase().includes(text));
}

function spanMatchesAttribute(
  span: Span,
  key: string,
  expectedValue: string
): boolean {
  const candidates = getSearchValues(span, key);
  if (!candidates.length) return false;

  if (!expectedValue) {
    return candidates.some((value) => value != null);
  }

  return candidates.some((value) =>
    valueToSearchString(value).toLocaleLowerCase().includes(expectedValue)
  );
}

function getSearchValues(span: Span, key: string): unknown[] {
  const candidates: unknown[] = [];
  const normalizedKey = key.toLocaleLowerCase();

  switch (normalizedKey) {
    case 'id':
    case 'spanid':
    case 'span.id':
      candidates.push(span.spanId);
      break;
    case 'name':
      candidates.push(span.name);
      break;
    case 'resource':
      candidates.push(span.resource);
      break;
    case 'library':
    case 'library.name':
      candidates.push(span.library.name);
      break;
    case 'library.version':
      candidates.push(span.library.version);
      break;
    case 'status':
    case 'status.code':
      candidates.push(span.status.code);
      break;
  }

  candidates.push(getOwnProperty(span.attributes, key));
  candidates.push(getPathValue(span.attributes, key));

  if (!normalizedKey.startsWith('data.')) {
    candidates.push(getPathValue(span.attributes.data, key));
  }

  return candidates.filter((value) => value !== undefined);
}

function getOwnProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined;
  if (!Object.hasOwn(source, key)) return undefined;
  return (source as Record<string, unknown>)[key];
}

function getPathValue(source: unknown, path: string): unknown {
  if (!source || typeof source !== 'object') return undefined;

  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (!segment) return undefined;
    current = getOwnProperty(current, segment);
    if (current === undefined) return undefined;
  }

  return current;
}

function valueToSearchString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (
    value == null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
