import { ELLIPSIS, toGraphemes } from './truncate';

interface GetMiddleTruncateCopyTextOptions {
  prefixText: string;
  selectionEnd: number;
  selectionStart: number;
  suffixText: string;
  value: string;
}

interface GetMiddleTruncateCopyTextFromSelectionTextOptions {
  prefixText: string;
  selectionText: string;
  suffixText: string;
  value: string;
}

function getMiddleTruncateCopyText({
  prefixText,
  selectionEnd,
  selectionStart,
  suffixText,
  value,
}: GetMiddleTruncateCopyTextOptions): string | null {
  const visibleText = prefixText + ELLIPSIS + suffixText;

  if (
    selectionStart < 0 ||
    selectionEnd > visibleText.length ||
    selectionStart >= selectionEnd
  ) {
    return null;
  }

  if (selectionStart === 0 && selectionEnd === visibleText.length) {
    return value;
  }

  const ellipsisStart = prefixText.length;
  const ellipsisEnd = ellipsisStart + ELLIPSIS.length;

  if (selectionStart > ellipsisStart || selectionEnd < ellipsisEnd) {
    return null;
  }

  const originalGraphemes = toGraphemes(value);
  const selectedPrefixGraphemeCount = toGraphemes(
    visibleText.slice(0, selectionStart)
  ).length;
  const selectedSuffixGraphemeCount = toGraphemes(
    visibleText.slice(ellipsisEnd, selectionEnd)
  ).length;
  const suffixStart = originalGraphemes.length - toGraphemes(suffixText).length;

  return originalGraphemes
    .slice(
      selectedPrefixGraphemeCount,
      suffixStart + selectedSuffixGraphemeCount
    )
    .join('');
}

function getMiddleTruncateCopyTextFromSelectionText({
  prefixText,
  selectionText,
  suffixText,
  value,
}: GetMiddleTruncateCopyTextFromSelectionTextOptions): string | null {
  const visibleText = prefixText + ELLIPSIS + suffixText;
  const trimmedSelectionText = selectionText.trim();

  if (!trimmedSelectionText) {
    return null;
  }

  const leading = selectionText.slice(
    0,
    selectionText.length - selectionText.trimStart().length
  );
  const trailing = selectionText.slice(selectionText.trimEnd().length);

  if (trimmedSelectionText === visibleText) {
    return leading + value + trailing;
  }

  if (!trimmedSelectionText.includes(ELLIPSIS)) {
    return null;
  }

  const selectionStart = visibleText.indexOf(trimmedSelectionText);
  if (selectionStart === -1) {
    return null;
  }

  const selectionEnd = selectionStart + trimmedSelectionText.length;
  const mappedText = getMiddleTruncateCopyText({
    prefixText,
    selectionEnd,
    selectionStart,
    suffixText,
    value,
  });

  return mappedText === null ? null : leading + mappedText + trailing;
}

export {
  getMiddleTruncateCopyText,
  getMiddleTruncateCopyTextFromSelectionText,
};
export type {
  GetMiddleTruncateCopyTextFromSelectionTextOptions,
  GetMiddleTruncateCopyTextOptions,
};
