'use client';

import type { Event, Hook, WorkflowRun } from '@workflow/world';
import { createContext, type ReactNode, useContext } from 'react';
import type { FetchSpanDetail } from './use-selected-span-detail';

export interface SidebarDataContextValue {
  run: WorkflowRun;
  events: Event[];
  /**
   * Loads the full detail (input/output/metadata) for a selected span. The
   * trace viewer owns the loading/ready/error state internally (see
   * `useSelectedSpanDetail`); the host only injects how to fetch.
   */
  fetchSpanDetail: FetchSpanDetail;
  onStreamClick?: (streamId: string) => void;
  onRunClick?: (runId: string) => void;
  onWakeUpSleep?: (
    runId: string,
    correlationId: string
  ) => Promise<{ stoppedCount: number }>;
  onLoadEventData?: (
    correlationId: string,
    eventId: string
  ) => Promise<unknown | null>;
  onResolveHook?: (
    hookToken: string,
    payload: unknown,
    hook?: Hook
  ) => Promise<void>;
  encryptionKey?: Uint8Array;
  onDecrypt?: () => void;
  isDecrypting?: boolean;
  hasEncryptedData?: boolean;
}

const SidebarDataContext = createContext<SidebarDataContextValue | null>(null);
SidebarDataContext.displayName = 'SidebarDataContext';

export function SidebarDataProvider({
  value,
  children,
}: {
  value: SidebarDataContextValue;
  children: ReactNode;
}) {
  return (
    <SidebarDataContext.Provider value={value}>
      {children}
    </SidebarDataContext.Provider>
  );
}

export function useSidebarData(): SidebarDataContextValue {
  const ctx = useContext(SidebarDataContext);
  if (!ctx) {
    throw new Error('useSidebarData must be used within a SidebarDataProvider');
  }
  return ctx;
}

export function useSidebarDataOptional(): SidebarDataContextValue | null {
  return useContext(SidebarDataContext);
}
