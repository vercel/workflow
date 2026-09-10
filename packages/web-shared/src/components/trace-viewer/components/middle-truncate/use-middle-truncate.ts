'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cancelMeasurement, scheduleMeasurement } from './measurement-batch';
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

interface MiddleTruncateMeasurement {
  availableWidth: number;
  typography: string;
}

interface TextMeasurementCache {
  typography: string;
  value: string;
  widths: Map<string, number>;
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
  const measurementKeyRef = useRef<object>({});
  const textMeasurementCacheRef = useRef<TextMeasurementCache>({
    typography: '',
    value,
    widths: new Map(),
  });
  const lastMeasurementRef = useRef<
    (MiddleTruncateMeasurement & { value: string }) | null
  >(null);

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

  const readMeasurement = useCallback((): MiddleTruncateMeasurement | null => {
    const el = ref.current;
    const measureEl = measureRef.current;
    if (!el || !measureEl) return null;

    const availableWidth = el.clientWidth;
    const style = getComputedStyle(measureEl);

    return {
      availableWidth,
      typography: [
        style.fontFamily,
        style.fontFeatureSettings,
        style.fontKerning,
        style.fontSize,
        style.fontStretch,
        style.fontStyle,
        style.fontVariationSettings,
        style.fontWeight,
        style.letterSpacing,
        style.textTransform,
      ].join('\0'),
    };
  }, []);

  const recalculate = useCallback(
    ({ availableWidth, typography }: MiddleTruncateMeasurement) => {
      const measureEl = measureRef.current;
      if (!measureEl) return;

      const lastMeasurement = lastMeasurementRef.current;
      if (
        lastMeasurement?.availableWidth === availableWidth &&
        lastMeasurement.typography === typography &&
        lastMeasurement.value === value
      ) {
        return;
      }

      lastMeasurementRef.current = {
        availableWidth,
        typography,
        value,
      };

      if (availableWidth <= 0) {
        updateState(fullState);
        return;
      }

      const textMeasurementCache = textMeasurementCacheRef.current;
      if (
        textMeasurementCache.typography !== typography ||
        textMeasurementCache.value !== value
      ) {
        textMeasurementCache.typography = typography;
        textMeasurementCache.value = value;
        textMeasurementCache.widths.clear();
      }

      const measure = (text: string): number => {
        const cachedWidth = textMeasurementCache.widths.get(text);
        if (cachedWidth !== undefined) {
          return cachedWidth;
        }

        measureEl.textContent = text;
        const width = measureEl.scrollWidth;
        textMeasurementCache.widths.set(text, width);
        return width;
      };

      const fullWidth = measure(value);

      if (fullWidth <= availableWidth) {
        updateState(fullState);
        return;
      }

      const result = middleTruncate(
        graphemes,
        availableWidth,
        measure,
        fullWidth
      );
      updateState({
        displayText: result.text,
        isTruncated: result.truncated,
        prefixGraphemeCount: result.prefixGraphemeCount,
        prefixText: result.prefixText,
        suffixGraphemeCount: result.suffixGraphemeCount,
        suffixText: result.suffixText,
      });
    },
    [fullState, graphemes, updateState, value]
  );

  // Measure on mount and when value changes - before paint
  useIsomorphicLayoutEffect(() => {
    const measurement = readMeasurement();
    if (measurement) {
      recalculate(measurement);
    }
  }, [readMeasurement, recalculate]);

  // ResizeObserver + font loading for ongoing responsiveness
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measurementKey = measurementKeyRef.current;
    const scheduleRecalculation = (): void => {
      scheduleMeasurement(measurementKey, {
        read: readMeasurement,
        measure: recalculate,
      });
    };

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleRecalculation)
        : null;
    ro?.observe(el);
    if (!ro) {
      window.addEventListener('resize', scheduleRecalculation);
    }

    const onFontsLoaded = (): void => {
      textMeasurementCacheRef.current.widths.clear();
      lastMeasurementRef.current = null;
      scheduleRecalculation();
    };
    const fontSet = 'fonts' in document ? document.fonts : null;
    fontSet?.addEventListener?.('loadingdone', onFontsLoaded);

    return () => {
      ro?.disconnect();
      if (!ro) {
        window.removeEventListener('resize', scheduleRecalculation);
      }
      cancelMeasurement(measurementKey);
      fontSet?.removeEventListener?.('loadingdone', onFontsLoaded);
    };
  }, [readMeasurement, recalculate]);

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
