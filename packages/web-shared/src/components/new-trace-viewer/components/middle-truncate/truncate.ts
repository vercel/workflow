const ELLIPSIS = '...';
const MIN_START = 3;
const MIN_END = 3;
const MIN_KEPT = MIN_START + MIN_END;
const graphemeSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

type MeasureFn = (text: string) => number;

/**
 * Splits a string into grapheme clusters using Intl.Segmenter.
 * Falls back to Array.from for environments without Intl.Segmenter.
 */
function toGraphemes(text: string): string[] {
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(text)].map((s) => s.segment);
  }
  return Array.from(text);
}

interface TruncateResult {
  prefixText: string;
  prefixGraphemeCount: number;
  suffixText: string;
  suffixGraphemeCount: number;
  text: string;
  truncated: boolean;
}

function buildCandidate(graphemes: string[], kept: number): TruncateResult {
  if (kept <= 0) {
    return {
      prefixText: '',
      prefixGraphemeCount: 0,
      suffixText: '',
      suffixGraphemeCount: 0,
      text: ELLIPSIS,
      truncated: true,
    };
  }

  const suffixGraphemeCount =
    kept >= MIN_KEPT
      ? Math.max(MIN_END, Math.floor(kept / 2))
      : Math.floor(kept / 2);
  const prefixGraphemeCount = kept - suffixGraphemeCount;
  const prefixText = graphemes.slice(0, prefixGraphemeCount).join('');
  const suffixText =
    suffixGraphemeCount > 0
      ? graphemes.slice(-suffixGraphemeCount).join('')
      : '';

  return {
    prefixText,
    prefixGraphemeCount,
    suffixText,
    suffixGraphemeCount,
    text: prefixText + ELLIPSIS + suffixText,
    truncated: true,
  };
}

/**
 * Middle-truncates a string so `prefix...suffix` fits within `availableWidth`.
 * Uses binary search over grapheme clusters with an injectable measure function.
 */
function middleTruncate(
  graphemes: string[],
  availableWidth: number,
  measure: MeasureFn,
  fullWidth?: number
): TruncateResult {
  const fullText = graphemes.join('');
  const resolvedFullWidth = fullWidth ?? measure(fullText);

  if (availableWidth <= 0 || graphemes.length === 0) {
    return {
      prefixText: fullText,
      prefixGraphemeCount: graphemes.length,
      suffixText: '',
      suffixGraphemeCount: 0,
      text: fullText,
      truncated: false,
    };
  }

  if (resolvedFullWidth <= availableWidth) {
    return {
      prefixText: fullText,
      prefixGraphemeCount: graphemes.length,
      suffixText: '',
      suffixGraphemeCount: 0,
      text: fullText,
      truncated: false,
    };
  }

  // Binary search for the maximum number of kept graphemes
  let lo = 0;
  let hi = graphemes.length - 1;
  let best = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = buildCandidate(graphemes, mid);

    if (measure(candidate.text) <= availableWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === -1) {
    return {
      prefixText: '',
      prefixGraphemeCount: 0,
      suffixText: '',
      suffixGraphemeCount: 0,
      text: '',
      truncated: true,
    };
  }

  return buildCandidate(graphemes, best);
}

export { middleTruncate, toGraphemes, ELLIPSIS, MIN_START, MIN_END };
export type { MeasureFn, TruncateResult };
