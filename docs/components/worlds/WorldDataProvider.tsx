'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { World } from './types';

interface WorldDataContextValue {
  worldId: string;
  world: World;
  meta: {
    lastUpdated: string;
    commit: string | null;
    branch: string | null;
  };
}

const WorldDataContext = createContext<WorldDataContextValue | null>(null);

interface WorldDataProviderProps {
  worldId: string;
  world: World;
  meta: {
    lastUpdated: string;
    commit: string | null;
    branch: string | null;
  };
  children: ReactNode;
}

export function WorldDataProvider({
  worldId,
  world,
  meta,
  children,
}: WorldDataProviderProps) {
  return (
    <WorldDataContext.Provider value={{ worldId, world, meta }}>
      {children}
    </WorldDataContext.Provider>
  );
}

export function useWorldData() {
  const context = useContext(WorldDataContext);
  if (!context) {
    throw new Error('useWorldData must be used within a WorldDataProvider');
  }
  return context;
}
