'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import type { SpanSelectionInfo } from './entity-detail-panel';

export interface SidebarDataContextValue {
  run: WorkflowRun;
  events: Event[];
  spanDetailData: WorkflowRun | Step | Hook | Event | null;
  spanDetailError?: Error | null;
  spanDetailLoading?: boolean;
  onSpanSelect: (info: SpanSelectionInfo) => void;
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
