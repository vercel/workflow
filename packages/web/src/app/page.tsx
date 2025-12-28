'use client';

import { ErrorBoundary } from '@workflow/web-shared';
import { useRouter } from 'next/navigation';
import { HooksTable } from '@/components/hooks-table';
import { RunsTable } from '@/components/runs-table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkflowsList } from '@/components/workflows-list';
import { buildUrlWithConfig, useQueryParamConfig } from '@/lib/config';
import { useHookIdState, useSidebarState, useTabState } from '@/lib/url-state';

export default function Home() {
  const router = useRouter();
  const config = useQueryParamConfig();
  const [sidebar] = useSidebarState();
  const [hookId] = useHookIdState();
  const [tab, setTab] = useTabState();

  const selectedHookId = sidebar === 'hook' && hookId ? hookId : undefined;

  // Only show workflows tab for local backend
  const isLocalBackend = config.backend === 'local';

  const handleRunClick = (runId: string, streamId?: string) => {
    if (!streamId) {
      router.push(buildUrlWithConfig(`/run/${runId}`, config));
    } else {
      router.push(
        buildUrlWithConfig(`/run/${runId}/streams/${streamId}`, config)
      );
    }
  };

  const handleHookSelect = (hookId: string, runId?: string) => {
    if (hookId) {
      router.push(
        buildUrlWithConfig(`/run/${runId}`, config, {
          sidebar: 'hook',
          hookId,
        })
      );
    } else {
      router.push(buildUrlWithConfig(`/run/${runId}`, config));
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
            <RunsTable config={config} onRunClick={handleRunClick} />
          </ErrorBoundary>
        </TabsContent>
        <TabsContent value="hooks">
          <ErrorBoundary
            title="Hooks Error"
            description="Failed to load hooks. Please try refreshing the page."
          >
            <HooksTable
              config={config}
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
              <WorkflowsList config={config} />
            </ErrorBoundary>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
