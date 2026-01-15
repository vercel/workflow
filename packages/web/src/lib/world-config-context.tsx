'use client';

import type { PublicServerConfig } from '@workflow/web-shared/server';
import { createContext, type ReactNode, useContext } from 'react';

// Re-export PublicServerConfig for convenience
export type { PublicServerConfig } from '@workflow/web-shared/server';

/**
 * Context value providing server configuration info to the UI.
 *
 * The web UI no longer supports dynamic world configuration via query params.
 * Configuration is read from server-side environment variables, consistent
 * with how the workflow runtime's createWorld() works.
 *
 * This context provides display-only information about the current configuration.
 * Sensitive data like connection strings and auth tokens are never sent to the client.
 */
export interface ServerConfigContextValue {
  /** Server configuration info (display-only, no sensitive data) */
  serverConfig: PublicServerConfig;
}

const ServerConfigContext = createContext<ServerConfigContextValue | null>(
  null
);

interface ServerConfigProviderProps {
  children: ReactNode;
  /** Server configuration fetched during SSR */
  serverConfig: PublicServerConfig;
}

/**
 * Provider component that makes server configuration available to child components.
 *
 * The serverConfig should be fetched during server-side rendering using
 * getPublicServerConfig() from @workflow/web-shared/server.
 */
export function ServerConfigProvider({
  children,
  serverConfig,
}: ServerConfigProviderProps) {
  const value: ServerConfigContextValue = {
    serverConfig,
  };

  return (
    <ServerConfigContext.Provider value={value}>
      {children}
    </ServerConfigContext.Provider>
  );
}

/**
 * Hook to access the server configuration context.
 *
 * Returns display-only information about the current world configuration.
 * This never includes sensitive data like connection strings or auth tokens.
 */
export function useServerConfig(): ServerConfigContextValue {
  const context = useContext(ServerConfigContext);
  if (!context) {
    throw new Error(
      'useServerConfig must be used within a ServerConfigProvider'
    );
  }
  return context;
}
