'use client';

import {
  Database,
  Folder,
  Globe,
  Lock,
  Server,
  Settings,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useServerConfig } from '@/lib/world-config-context';

interface SettingsSidebarProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Settings sidebar that displays read-only configuration information.
 *
 * The web UI no longer supports dynamic configuration via query params.
 * All configuration is read from server-side environment variables.
 * This sidebar shows the current configuration status without exposing
 * sensitive data like connection strings or auth tokens.
 */
export function SettingsSidebar({
  open: controlledOpen,
  onOpenChange,
}: SettingsSidebarProps = {}) {
  const { serverConfig } = useServerConfig();
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setIsOpen = onOpenChange || setInternalOpen;

  const { backendDisplayName, backendId, displayInfo } = serverConfig;

  // Determine icon based on backend type
  const BackendIcon =
    backendId === 'local' || backendId === '@workflow/world-local'
      ? Folder
      : backendId === 'vercel' || backendId === '@workflow/world-vercel'
        ? Globe
        : backendId === '@workflow/world-postgres' || backendId === 'postgres'
          ? Database
          : Server;

  return (
    <>
      {controlledOpen === undefined && (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="p-2 rounded-full hover:bg-accent transition-colors"
          title="Configuration"
        >
          <Settings className="h-6 w-6" />
        </button>
      )}
      {isOpen && (
        <>
          {/* Backdrop */}
          <button
            type="button"
            className="fixed inset-0 bg-black/50 z-40 cursor-default"
            onClick={() => setIsOpen(false)}
            aria-label="Close configuration panel"
          />

          {/* Panel */}
          <div className="fixed top-0 right-0 h-full w-96 bg-background border-l shadow-lg z-50 overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold">Configuration</h2>
                <Button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  variant="outline"
                  size="icon"
                >
                  <X className="h-5 w-5" />
                </Button>
              </div>

              <div className="space-y-6">
                {/* Environment-based configuration notice */}
                <Alert className="!bg-blue-500/10 !border-blue-500/20">
                  <Lock className="h-4 w-4" />
                  <AlertTitle>Environment Configuration</AlertTitle>
                  <AlertDescription>
                    Configuration is set via server environment variables. Use
                    the CLI or environment variables to configure the world
                    backend.
                  </AlertDescription>
                </Alert>

                {/* Backend info card */}
                <div className="rounded-lg border p-4 space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <BackendIcon className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{backendDisplayName}</h3>
                      <p className="text-sm text-muted-foreground">
                        World Backend
                      </p>
                    </div>
                  </div>

                  {/* Backend-specific display info */}
                  {displayInfo && (
                    <div className="space-y-3 pt-2 border-t overflow-hidden">
                      {displayInfo.dataDir && (
                        <ConfigRow label="Data Directory">
                          <code
                            className="text-xs bg-muted px-2 py-1 rounded truncate max-w-[200px]"
                            title={displayInfo.dataDir}
                          >
                            {displayInfo.dataDir}
                          </code>
                        </ConfigRow>
                      )}

                      {displayInfo.hostname && (
                        <ConfigRow label="Host">
                          <code
                            className="text-xs bg-muted px-2 py-1 rounded truncate max-w-[200px]"
                            title={displayInfo.hostname}
                          >
                            {displayInfo.hostname}
                          </code>
                        </ConfigRow>
                      )}

                      {displayInfo.database && (
                        <ConfigRow label="Database">
                          <code
                            className="text-xs bg-muted px-2 py-1 rounded truncate max-w-[200px]"
                            title={displayInfo.database}
                          >
                            {displayInfo.database}
                          </code>
                        </ConfigRow>
                      )}

                      {displayInfo.environment && (
                        <ConfigRow label="Environment">
                          <span className="text-sm capitalize">
                            {displayInfo.environment}
                          </span>
                        </ConfigRow>
                      )}

                      {displayInfo.projectName && (
                        <ConfigRow label="Project">
                          <code
                            className="text-xs bg-muted px-2 py-1 rounded truncate max-w-[200px]"
                            title={displayInfo.projectName}
                          >
                            {displayInfo.projectName}
                          </code>
                        </ConfigRow>
                      )}

                      {displayInfo.teamName && (
                        <ConfigRow label="Team">
                          <code
                            className="text-xs bg-muted px-2 py-1 rounded truncate max-w-[200px]"
                            title={displayInfo.teamName}
                          >
                            {displayInfo.teamName}
                          </code>
                        </ConfigRow>
                      )}
                    </div>
                  )}
                </div>

                {/* Close button */}
                <Button
                  variant="outline"
                  onClick={() => setIsOpen(false)}
                  className="w-full"
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** Helper component for displaying config rows */
function ConfigRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 min-w-0">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <div className="min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}
