'use client';

import { ErrorBoundary } from '@workflow/web-shared';
import { useRouter } from 'next/navigation';
import { HooksTable } from '@/components/hooks-table';
import { RunsTable } from '@/components/runs-table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkflowsList } from '@/components/workflows-list';
import { useHookIdState, useSidebarState, useTabState } from '@/lib/url-state';
import { useServerConfig } from '@/lib/world-config-context';

export default function Home() {
  const router = useRouter();
  const { serverConfig } = useServerConfig();
  const [sidebar] = useSidebarState();
  const [hookId] = useHookIdState();
  const [tab, setTab] = useTabState();

  const selectedHookId = sidebar === 'hook' && hookId ? hookId : undefined;

  // Only show workflows tab for local backend
  const isLocalBackend =
    serverConfig.backendId === 'local' ||
    serverConfig.backendId === '@workflow/world-local';

  const handleRunClick = (runId: string, streamId?: string) => {
    if (!streamId) {
      router.push(`/run/${runId}`);
    } else {
      router.push(`/run/${runId}/streams/${streamId}`);
    }
  };

  const handleHookSelect = (hookId: string, runId?: string) => {
    if (hookId) {
      router.push(`/run/${runId}?sidebar=hook&hookId=${hookId}`);
    } else {
      router.push(`/run/${runId}`);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4">
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="hooks">Hooks</TabsTrigger>
          {isLocalBackend && (
            <TabsTrigger value="workflows">Workflows</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="runs">
          <ErrorBoundary
            title="Runs Error"
            description="Failed to load workflow runs. Please try refreshing the page."
          >
            <RunsTable onRunClick={handleRunClick} />
          </ErrorBoundary>
        </TabsContent>
        <TabsContent value="hooks">
          <ErrorBoundary
            title="Hooks Error"
            description="Failed to load hooks. Please try refreshing the page."
          >
            <HooksTable
              onHookClick={handleHookSelect}
              selectedHookId={selectedHookId}
            />
          </ErrorBoundary>
        </TabsContent>
        {isLocalBackend && (
          <TabsContent value="workflows">
            <ErrorBoundary
              title="Workflows Error"
              description="Failed to load workflow graph data. Please try refreshing the page."
            >
              <WorkflowsList />
            </ErrorBoundary>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
