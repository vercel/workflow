'use client';

import { useCallback, useRef } from 'react';
import type { ClipboardEvent, ComponentPropsWithoutRef, JSX } from 'react';
import { cn } from '../../../../lib/utils';
import {
  getMiddleTruncateCopyText,
  getMiddleTruncateCopyTextFromSelectionText,
} from './copy-selection';
import { ELLIPSIS } from './truncate';
import { useMiddleTruncate } from './use-middle-truncate';

/** Props for the {@link MiddleTruncate} component. */
interface MiddleTruncateProps
  extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  /** The full text string to display, truncated from the middle when it overflows. */
  value: string;
}

function getRangeOffsets(
  container: HTMLElement,
  range: Range
): { end: number; start: number } | null {
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return null;
  }

  const startRange = document.createRange();
  startRange.selectNodeContents(container);
  startRange.setEnd(range.startContainer, range.startOffset);

  const endRange = document.createRange();
  endRange.selectNodeContents(container);
  endRange.setEnd(range.endContainer, range.endOffset);

  return {
    end: endRange.toString().length,
    start: startRange.toString().length,
  };
}

/**
 * @gdoc
 *
 * Truncates text from the middle with an ellipsis when it overflows, preserving the beginning and end (e.g. file paths, URLs). Copy behavior restores the full untruncated text to the clipboard.
 * Renders a `<span>` element.
 *
 * Documentation: [Geist Middle Truncate](https://vercel.com/geist/middle-truncate)
 *
 * @param value - Full text string to display.
 */
function MiddleTruncate({
  value,
  className,
  onCopy: onCopyProp,
  ...props
}: MiddleTruncateProps): JSX.Element {
  const { ref, measureRef, displayText, isTruncated, prefixText, suffixText } =
    useMiddleTruncate(value);
  const visibleRef = useRef<HTMLSpanElement | null>(null);

  const handleCopy = useCallback(
    (e: ClipboardEvent<HTMLSpanElement>) => {
      onCopyProp?.(e);
      if (e.defaultPrevented || !isTruncated) return;

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const selectionText = selection.toString();
      if (!selectionText) return;

      // Only intercept when the selection is fully within this element.
      // If the user selected across elements (e.g. a table row), let
      // the browser's default behavior preserve surrounding context.
      const range = selection.getRangeAt(0);
      const visibleEl = visibleRef.current;
      let copyText: string | null = null;

      if (
        e.currentTarget.contains(range.startContainer) &&
        e.currentTarget.contains(range.endContainer) &&
        visibleEl
      ) {
        const offsets = getRangeOffsets(visibleEl, range);
        if (offsets) {
          copyText = getMiddleTruncateCopyText({
            prefixText,
            selectionEnd: offsets.end,
            selectionStart: offsets.start,
            suffixText,
            value,
          });
        }
      }

      copyText ??= getMiddleTruncateCopyTextFromSelectionText({
        prefixText,
        selectionText,
        suffixText,
        value,
      });

      if (copyText === null) return;

      e.preventDefault();
      e.clipboardData.setData('text/plain', copyText);
    },
    [onCopyProp, isTruncated, prefixText, suffixText, value]
  );

  return (
    <span
      title={isTruncated ? value : undefined}
      {...props}
      ref={ref}
      className={cn(
        'relative inline-grid min-w-0 max-w-full overflow-hidden whitespace-nowrap',
        className
      )}
      onCopy={handleCopy}
    >
      {isTruncated && <span className='sr-only select-none'>{value}</span>}
      <span
        aria-hidden='true'
        className='pointer-events-none col-start-1 row-start-1 invisible select-none whitespace-nowrap'
      >
        {value}
      </span>
      <span
        aria-hidden={isTruncated || undefined}
        className='col-start-1 row-start-1 min-w-0 overflow-hidden'
        ref={visibleRef}
      >
        {isTruncated ? (
          <>
            <span>{prefixText}</span>
            <span>{ELLIPSIS}</span>
            <span>{suffixText}</span>
          </>
        ) : (
          displayText
        )}
      </span>
      <span
        aria-hidden='true'
        className='pointer-events-none absolute left-0 top-0 inline-block invisible select-none whitespace-nowrap'
        ref={measureRef}
      />
    </span>
  );
}

export { MiddleTruncate };
export type { MiddleTruncateProps };
