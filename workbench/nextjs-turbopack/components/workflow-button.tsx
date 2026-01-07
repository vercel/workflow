'use client';

import type { WorkflowDefinition } from '@/app/workflows/definitions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface WorkflowButtonProps {
  workflow: WorkflowDefinition;
  onStart: (workflowName: string, args: unknown[]) => void;
}

export function WorkflowButton({ workflow, onStart }: WorkflowButtonProps) {
  const hasArgs = workflow.defaultArgs.length > 0;

  return (
    <Card className="hover:shadow-md transition-shadow p-3">
      <div className="flex items-center justify-between gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex-1 min-w-0 cursor-help">
              <div className="flex items-baseline gap-2">
                <h3 className="text-sm font-semibold font-mono truncate">
                  {workflow.displayName}
                </h3>
                {hasArgs && (
                  <code className="text-xs text-muted-foreground">
                    ({workflow.defaultArgs.length} arg
                    {workflow.defaultArgs.length !== 1 ? 's' : ''})
                  </code>
                )}
              </div>
              {hasArgs && (
                <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap">
                  {JSON.stringify(workflow.defaultArgs, null, 2)}
                </pre>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-md">
            <div className="space-y-1">
              <div className="font-semibold font-mono">
                {workflow.displayName}
              </div>
              <div className="text-xs opacity-80 font-mono">
                {workflow.workflowFile}
              </div>
              {hasArgs ? (
                <>
                  <div className="text-xs opacity-80">Default Arguments:</div>
                  <pre className="text-xs bg-black/20 p-2 rounded overflow-x-auto">
                    {JSON.stringify(workflow.defaultArgs, null, 2)}
                  </pre>
                </>
              ) : (
                <div className="text-xs opacity-80">No arguments required</div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
        <Button
          size="sm"
          onClick={() => onStart(workflow.name, workflow.defaultArgs)}
          className="shrink-0"
        >
          Start
        </Button>
      </div>
    </Card>
  );
}
