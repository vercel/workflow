'use client';

import type { Event, Hook, WorkflowRun } from '@workflow/world';
import { createContext, type ReactNode, useContext } from 'react';
import type { FetchSpanDetail } from './use-selected-span-detail';

export interface SidebarDataContextValue {
  run: WorkflowRun;
  events: Event[];
  fetchSpanDetail: FetchSpanDetail;
  onStreamClick?: (streamId: string) => void;
  onRunClick?: (runId: string) => void;
  onWakeUpSleep?: (
    runId: string,
    correlationId: string
  ) => Promise<{ stoppedCount: number }>;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  onResolveHook?: (
    hookToken: string,
    payload: unknown,
    hook?: Hook
  ) => Promise<void>;
  encryptionKey?: Uint8Array;
  onDecrypt?: () => void;
  isDecrypting?: boolean;
  hasEncryptedData?: boolean;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
  getModuleSourceUrl?: (info: {
    moduleSpecifier: string;
    deploymentId: string;
  }) => string | undefined;
  /**
   * Async variant of {@link getModuleSourceUrl}. When provided, the detail
   * panel awaits this to obtain a fully-resolved source link (e.g. one that
   * has looked up the file's real extension against the deployment's source
   * tree) and prefers it over the synchronous `getModuleSourceUrl` result.
   * Should resolve to `undefined` when it cannot produce a better link, so the
   * panel falls back to the synchronous best-effort value.
   */
  resolveModuleSourceUrl?: (info: {
    moduleSpecifier: string;
    deploymentId: string;
  }) => Promise<string | undefined>;
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
