'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Span } from './types';

interface ActiveSpanContextValue {
  activeSpanId: string | null;
  activeSpan: Span | null;
  /** The full span list the selection lives in (ordered as rendered). */
  spans: Span[];
  setActiveSpan: (spanId: string) => void;
  clearActiveSpan: () => void;
}

const ActiveSpanContext = createContext<ActiveSpanContextValue | null>(null);
ActiveSpanContext.displayName = 'ActiveSpanContext';

export function ActiveSpanProvider({
  spans,
  initialActiveSpanId,
  children,
}: {
  spans: Span[];
  /** Span to preselect on mount (e.g. from a deep link). */
  initialActiveSpanId?: string | null;
  children: ReactNode;
}) {
  const [activeSpanId, setActiveSpanId] = useState<string | null>(
    initialActiveSpanId ?? null
  );

  useEffect(() => {
    setActiveSpanId((currentSpanId) => {
      if (!currentSpanId) {
        return null;
      }

      // While spans are still loading, keep a pending (deep-linked)
      // selection alive so it can resolve once the data arrives.
      if (spans.length === 0) {
        return currentSpanId;
      }

      const hasCurrentSpan = spans.some(
        (span) => span.spanId === currentSpanId
      );
      if (hasCurrentSpan) {
        return currentSpanId;
      }

      return null;
    });
  }, [spans]);

  const activeSpan = useMemo(() => {
    if (!activeSpanId) {
      return null;
    }

    return spans.find((span) => span.spanId === activeSpanId) ?? null;
  }, [activeSpanId, spans]);

  const setActiveSpan = useCallback((spanId: string) => {
    setActiveSpanId(spanId);
  }, []);

  const clearActiveSpan = useCallback(() => {
    setActiveSpanId(null);
  }, []);

  const value = useMemo<ActiveSpanContextValue>(
    () => ({
      activeSpanId,
      activeSpan,
      spans,
      setActiveSpan,
      clearActiveSpan,
    }),
    [activeSpanId, activeSpan, spans, setActiveSpan, clearActiveSpan]
  );

  return (
    <ActiveSpanContext.Provider value={value}>
      {children}
    </ActiveSpanContext.Provider>
  );
}

export const useActiveSpan = (): ActiveSpanContextValue => {
  const context = useContext(ActiveSpanContext);
  if (!context) {
    throw new Error('useActiveSpan must be used within ActiveSpanProvider');
  }

  return context;
};
