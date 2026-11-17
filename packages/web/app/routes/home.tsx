import { ErrorBoundary as ErrorBoundaryComponent } from '@workflow/web-shared';
import { useNavigate } from 'react-router';
import { HooksTable } from '~/components/hooks-table';
import { RunsTable } from '~/components/runs-table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { WorkflowsList } from '~/components/workflows-list';
import { useOptimisticSearchParams } from '~/lib/url-state';
import { useServerConfig } from '~/lib/world-config-context';

export default function Home() {
  const navigate = useNavigate();
  const { serverConfig } = useServerConfig();
  const [searchParams, updateSearchParams] = useOptimisticSearchParams();

  const sidebar = searchParams.get('sidebar');
  const hookId = searchParams.get('hookId');
  const tab = searchParams.get('tab') || 'runs';

  const setTab = (value: string) => {
    updateSearchParams({ tab: value }, { replace: true });
  };

  const selectedHookId = sidebar === 'hook' && hookId ? hookId : undefined;

  // Only show workflows tab for local backend
  const isLocalBackend =
    serverConfig.backendId === 'local' ||
    serverConfig.backendId === '@workflow/world-local';

  const handleRunClick = (runId: string, streamId?: string) => {
    if (!streamId) {
      navigate(`/run/${runId}`);
    } else {
      navigate(`/run/${runId}/streams/${streamId}`);
    }
  };

  const handleHookSelect = (hookId: string, runId?: string) => {
    if (hookId) {
      navigate(`/run/${runId}?sidebar=hook&hookId=${hookId}`);
    } else {
      navigate(`/run/${runId}`);
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
          <ErrorBoundaryComponent title="Failed to load workflow runs">
            <RunsTable onRunClick={handleRunClick} />
          </ErrorBoundaryComponent>
        </TabsContent>
        <TabsContent value="hooks">
          <ErrorBoundaryComponent title="Failed to load hooks">
            <HooksTable
              onHookClick={handleHookSelect}
              selectedHookId={selectedHookId}
            />
          </ErrorBoundaryComponent>
        </TabsContent>
        {isLocalBackend && (
          <TabsContent value="workflows">
            <ErrorBoundaryComponent title="Failed to load workflow graph data">
              <WorkflowsList />
            </ErrorBoundaryComponent>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
