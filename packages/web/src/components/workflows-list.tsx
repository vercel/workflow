'use client';

import { pluralize } from '@workflow/utils';
import { AlertCircle, GitBranch, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import { WorkflowGraphViewer } from '@/components/flow-graph/workflow-graph-viewer';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { WorldConfig } from '@/lib/config-world';
import { useWorkflowGraphManifest } from '@/lib/flow-graph/use-workflow-graph';
import type { WorkflowGraph } from '@/lib/flow-graph/workflow-graph-types';
import { TableSkeleton } from './display-utils/table-skeleton';

interface WorkflowsListProps {
  config: WorldConfig;
  onWorkflowSelect?: (workflowName: string) => void;
}

export function WorkflowsList({
  config,
  onWorkflowSelect,
}: WorkflowsListProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] =
    useState<WorkflowGraph | null>(null);

  // Fetch workflow graph manifest
  const {
    manifest: graphManifest,
    loading,
    error: graphError,
  } = useWorkflowGraphManifest(config);

  const workflows = graphManifest ? Object.values(graphManifest.workflows) : [];

  // Sort workflows alphabetically by name
  const sortedWorkflows = useMemo(
    () =>
      [...workflows].sort((a, b) =>
        a.workflowName.localeCompare(b.workflowName)
      ),
    [workflows]
  );

  const selectedWorkflowStepCount = useMemo(
    () =>
      selectedWorkflow?.nodes.filter((node) => node.data.nodeKind === 'step')
        .length ?? 0,
    [selectedWorkflow]
  );

  const handleViewWorkflow = (workflow: WorkflowGraph) => {
    setSelectedWorkflow(workflow);
    setSheetOpen(true);
    onWorkflowSelect?.(workflow.workflowName);
  };

  if (loading) {
    return <TableSkeleton variant="workflows" rows={6} />;
  }

  if (graphError) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error Loading Workflows</AlertTitle>
        <AlertDescription>{graphError.message}</AlertDescription>
      </Alert>
    );
  }

  if (workflows.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <Workflow className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Workflows Found</h3>
          <p className="text-sm text-muted-foreground">
            No workflow definitions were found in the graph manifest.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="overflow-hidden bg-background">
        <CardContent className="p-0 max-h-[calc(100vh-200px)] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                  Workflow
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                  File
                </TableHead>
                <TableHead className="text-center sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                  Steps
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedWorkflows.map((workflow) => {
                const stepCount = workflow.nodes.filter(
                  (node) => node.data.nodeKind === 'step'
                ).length;

                return (
                  <TableRow
                    key={workflow.workflowId}
                    className="cursor-pointer"
                    onClick={() => handleViewWorkflow(workflow)}
                  >
                    <TableCell className="py-2">
                      <span className="font-medium">
                        {workflow.workflowName}
                      </span>
                    </TableCell>
                    <TableCell className="py-2">
                      <code className="text-xs text-muted-foreground">
                        {workflow.filePath}
                      </code>
                    </TableCell>
                    <TableCell className="text-center py-2">
                      <Badge variant="secondary" className="gap-1">
                        <GitBranch className="h-3 w-3" />
                        {stepCount} {pluralize('step', 'steps', stepCount)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          className="w-[75vw] max-w-[75vw] sm:max-w-[75vw]"
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Workflow className="h-5 w-5" />
              {selectedWorkflow?.workflowName}
            </SheetTitle>
            {selectedWorkflow && (
              <SheetDescription asChild>
                <div className="space-y-2">
                  <code className="text-xs">{selectedWorkflow.filePath}</code>
                  <div>
                    <Badge variant="outline" className="gap-1">
                      <GitBranch className="h-3 w-3" />
                      {selectedWorkflowStepCount}{' '}
                      {pluralize('step', 'steps', selectedWorkflowStepCount)}
                    </Badge>
                  </div>
                </div>
              </SheetDescription>
            )}
          </SheetHeader>
          <div className="mt-6 h-[calc(100vh-180px)]">
            {selectedWorkflow && (
              <WorkflowGraphViewer workflow={selectedWorkflow} />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
