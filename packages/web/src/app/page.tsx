'use client';

import { AlertCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ErrorBoundary } from '@/components/error-boundary';
import { HooksTable } from '@/components/hooks-table';
import { RunsTable } from '@/components/runs-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkflowsList } from '@/components/workflows-list';
import { buildUrlWithConfig, useQueryParamConfig } from '@/lib/config';
import {
  useHookIdState,
  useSidebarState,
  useTabState,
  useWorkflowIdState,
} from '@/lib/url-state';
import { useWorkflowGraphManifest } from '@/lib/use-workflow-graph';

export default function Home() {
  const router = useRouter();
  const config = useQueryParamConfig();
  const [sidebar] = useSidebarState();
  const [hookId] = useHookIdState();
  const [tab, setTab] = useTabState();

  const selectedHookId = sidebar === 'hook' && hookId ? hookId : undefined;

  // TODO(Karthik): Uncomment after https://github.com/vercel/workflow/pull/455 is merged
  // Fetch workflow graph manifest
  // const {
  //   manifest: graphManifest,
  //   loading: graphLoading,
  //   error: graphError,
  // } = useWorkflowGraphManifest(config);

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

  // TODO(Karthik): Uncomment after https://github.com/vercel/workflow/pull/455 is merged.
  // const workflows = graphManifest ? Object.values(graphManifest.workflows) : [];

  return (
    <div className="max-w-7xl mx-auto px-4">
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="hooks">Hooks</TabsTrigger>
          {/* TODO(Karthik): Uncomment after https://github.com/vercel/workflow/pull/455 is merged */}
          {/* <TabsTrigger value="workflows">Workflows</TabsTrigger> */}
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
        {/* TODO(Karthik): Uncomment after https://github.com/vercel/workflow/pull/455 is merged */}
        {/* <TabsContent value="workflows">
          <ErrorBoundary
            title="Workflows Error"
            description="Failed to load workflow graph data. Please try refreshing the page."
          >
            <div className="space-y-6">
              {graphError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Error Loading Workflows</AlertTitle>
                  <AlertDescription>{graphError.message}</AlertDescription>
                </Alert>
              )}
              <WorkflowsList
                workflows={workflows}
                onWorkflowSelect={() => {}}
                loading={graphLoading}
              />
            </div>
          </ErrorBoundary>
        </TabsContent> */}
      </Tabs>
    </div>
  );
}
