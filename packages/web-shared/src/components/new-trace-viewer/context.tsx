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
import type { Span } from '../trace-viewer/types';

interface ActiveSpanContextValue {
  activeSpanId: string | null;
  activeSpan: Span | null;
  setActiveSpan: (spanId: string) => void;
  clearActiveSpan: () => void;
}

const ActiveSpanContext = createContext<ActiveSpanContextValue | null>(null);
ActiveSpanContext.displayName = 'ActiveSpanContext';

export function ActiveSpanProvider({
  spans,
  children,
}: {
  spans: Span[];
  children: ReactNode;
}) {
  const [activeSpanId, setActiveSpanId] = useState<string | null>(null);

  useEffect(() => {
    setActiveSpanId((currentSpanId) => {
      if (!currentSpanId) {
        return null;
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
      setActiveSpan,
      clearActiveSpan,
    }),
    [activeSpanId, activeSpan, setActiveSpan, clearActiveSpan]
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
