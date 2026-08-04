'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { middleTruncate, toGraphemes } from './truncate';

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

interface MiddleTruncateState {
  displayText: string;
  isTruncated: boolean;
  prefixGraphemeCount: number;
  prefixText: string;
  suffixGraphemeCount: number;
  suffixText: string;
}

function createFullState(
  value: string,
  graphemes: string[]
): MiddleTruncateState {
  return {
    displayText: value,
    isTruncated: false,
    prefixGraphemeCount: graphemes.length,
    prefixText: value,
    suffixGraphemeCount: 0,
    suffixText: '',
  };
}

/**
 * Middle-truncation logic. Returns refs to attach to the container and measurement elements, plus the truncated display text. Recalculates on resize, font loading, and value changes.
 * Powers the `<MiddleTruncate>` (`<span>`) component.
 *
 * Documentation: [Geist Middle Truncate](https://vercel.com/geist/middle-truncate)
 *
 * @param value - Full text string to truncate.
 */
function useMiddleTruncate(value: string): {
  ref: React.RefObject<HTMLSpanElement | null>;
  measureRef: React.RefObject<HTMLSpanElement | null>;
  displayText: string;
  isTruncated: boolean;
  prefixGraphemeCount: number;
  prefixText: string;
  suffixGraphemeCount: number;
  suffixText: string;
} {
  const graphemes = useMemo(() => toGraphemes(value), [value]);
  const fullState = useMemo(
    () => createFullState(value, graphemes),
    [graphemes, value]
  );
  const ref = useRef<HTMLSpanElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [state, setState] = useState<MiddleTruncateState>(() => fullState);
  const rafRef = useRef<number>(0);

  const updateState = useCallback((nextState: MiddleTruncateState) => {
    setState((currentState) => {
      if (
        currentState.displayText === nextState.displayText &&
        currentState.isTruncated === nextState.isTruncated &&
        currentState.prefixText === nextState.prefixText &&
        currentState.prefixGraphemeCount === nextState.prefixGraphemeCount &&
        currentState.suffixText === nextState.suffixText &&
        currentState.suffixGraphemeCount === nextState.suffixGraphemeCount
      ) {
        return currentState;
      }

      return nextState;
    });
  }, []);

  const recalculate = useCallback(() => {
    const el = ref.current;
    const measureEl = measureRef.current;
    if (!el || !measureEl) return;

    const available = el.clientWidth;

    if (available <= 0) {
      updateState(fullState);
      return;
    }

    const measure = (text: string): number => {
      measureEl.textContent = text;
      return measureEl.scrollWidth;
    };

    const fullWidth = measure(value);

    if (fullWidth <= available) {
      updateState(fullState);
      return;
    }

    const result = middleTruncate(graphemes, available, measure, fullWidth);
    updateState({
      displayText: result.text,
      isTruncated: result.truncated,
      prefixGraphemeCount: result.prefixGraphemeCount,
      prefixText: result.prefixText,
      suffixGraphemeCount: result.suffixGraphemeCount,
      suffixText: result.suffixText,
    });
  }, [fullState, graphemes, updateState, value]);

  // Measure on mount and when value changes - before paint
  useIsomorphicLayoutEffect(() => {
    recalculate();
  }, [recalculate]);

  // ResizeObserver + font loading for ongoing responsiveness
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const debouncedRecalc = (): void => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(recalculate);
    };

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(debouncedRecalc)
        : null;
    ro?.observe(el);
    window.addEventListener('resize', debouncedRecalc);

    const onFontsLoaded = (): void => {
      debouncedRecalc();
    };
    const fontSet = 'fonts' in document ? document.fonts : null;
    fontSet?.addEventListener?.('loadingdone', onFontsLoaded);

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', debouncedRecalc);
      cancelAnimationFrame(rafRef.current);
      fontSet?.removeEventListener?.('loadingdone', onFontsLoaded);
    };
  }, [recalculate]);

  return {
    ref,
    measureRef,
    displayText: state.displayText,
    isTruncated: state.isTruncated,
    prefixGraphemeCount: state.prefixGraphemeCount,
    prefixText: state.prefixText,
    suffixGraphemeCount: state.suffixGraphemeCount,
    suffixText: state.suffixText,
  };
}

export { useMiddleTruncate };
