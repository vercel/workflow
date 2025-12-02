'use client';

import { GitBranch, Workflow } from 'lucide-react';
import { useState } from 'react';
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
import { WorkflowGraphViewer } from '@/components/workflow-graph-viewer';
import type { WorkflowGraph } from '@/lib/workflow-graph-types';
import { TableSkeleton } from './display-utils/table-skeleton';

interface WorkflowsListProps {
  workflows: WorkflowGraph[];
  onWorkflowSelect: (workflowName: string) => void;
  loading?: boolean;
}

export function WorkflowsList({
  workflows,
  onWorkflowSelect,
  loading,
}: WorkflowsListProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] =
    useState<WorkflowGraph | null>(null);

  const handleViewWorkflow = (workflow: WorkflowGraph) => {
    setSelectedWorkflow(workflow);
    setSheetOpen(true);
    onWorkflowSelect(workflow.workflowName);
  };

  if (loading) {
    return <TableSkeleton variant="workflows" rows={6} />;
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
              {workflows.map((workflow) => {
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
                        {stepCount} {stepCount === 1 ? 'step' : 'steps'}
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
                      {
                        selectedWorkflow.nodes.filter(
                          (node) => node.data.nodeKind === 'step'
                        ).length
                      }{' '}
                      {selectedWorkflow.nodes.filter(
                        (node) => node.data.nodeKind === 'step'
                      ).length === 1
                        ? 'step'
                        : 'steps'}
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
