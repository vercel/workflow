import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { allWorkflows } from '@/_workflows';
import { WORKFLOW_DEFINITIONS } from '@/app/workflows/definitions';
import type { WorkflowName } from '@/app/workflows/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { workflowName, workflowFile, workflowFn, args, responseMode } =
      body as {
        workflowName?: WorkflowName;
        workflowFile?: string;
        workflowFn?: string;
        args?: unknown[];
        responseMode?: 'run';
      };

    let resolvedWorkflowFn: (() => Promise<unknown>) | undefined;
    let resolvedWorkflowName: string | undefined;
    if (workflowFile && workflowFn) {
      const workflows = allWorkflows[workflowFile as keyof typeof allWorkflows];
      if (!workflows) {
        return NextResponse.json(
          { error: `Workflow file "${workflowFile}" not found` },
          { status: 404 }
        );
      }

      if (workflowFn.includes('.')) {
        const [className, methodName] = workflowFn.split('.');
        const cls = workflows[className as keyof typeof workflows];
        if (cls && typeof cls === 'function') {
          resolvedWorkflowFn = (cls as Record<string, unknown>)[methodName] as
            | (() => Promise<unknown>)
            | undefined;
        }
      } else {
        resolvedWorkflowFn = workflows[workflowFn as keyof typeof workflows] as
          | (() => Promise<unknown>)
          | undefined;
      }

      if (typeof resolvedWorkflowFn !== 'function') {
        return NextResponse.json(
          { error: `Workflow "${workflowFn}" is not a function` },
          { status: 400 }
        );
      }

      resolvedWorkflowName = workflowFn;
    } else {
      const typedWorkflowName = workflowName;
      if (!typedWorkflowName) {
        return NextResponse.json(
          { error: 'workflowName or workflowFile/workflowFn is required' },
          { status: 400 }
        );
      }

      resolvedWorkflowName = typedWorkflowName;

      // Find workflow definition
      const definition = WORKFLOW_DEFINITIONS.find(
        (w) => w.name === typedWorkflowName
      );
      if (!definition) {
        return NextResponse.json(
          { error: `Workflow "${typedWorkflowName}" not found` },
          { status: 404 }
        );
      }

      // Get the workflow file
      const workflows =
        allWorkflows[definition.workflowFile as keyof typeof allWorkflows];
      if (!workflows) {
        return NextResponse.json(
          { error: `Workflow file "${definition.workflowFile}" not found` },
          { status: 404 }
        );
      }

      // Get the workflow function
      resolvedWorkflowFn = workflows[
        typedWorkflowName as keyof typeof workflows
      ] as () => Promise<unknown>;
      if (typeof resolvedWorkflowFn !== 'function') {
        return NextResponse.json(
          { error: `Workflow "${typedWorkflowName}" is not a function` },
          { status: 400 }
        );
      }
    }

    if (!resolvedWorkflowFn || !resolvedWorkflowName) {
      return NextResponse.json(
        { error: 'Failed to resolve workflow function' },
        { status: 500 }
      );
    }

    let workflowArgs = args ?? [];
    if (workflowArgs === undefined) {
      workflowArgs = [];
    }

    if (workflowArgs.length === 0 && workflowName) {
      const definition = WORKFLOW_DEFINITIONS.find(
        (w) => w.name === workflowName
      );
      if (definition) {
        workflowArgs = definition.defaultArgs;
      }
    }

    // Start the workflow
    // @ts-expect-error - we're doing arbitrary calls to unknown functions
    const run = await start(resolvedWorkflowFn, workflowArgs);

    if (!run) {
      return NextResponse.json(
        { error: 'Failed to get workflow run' },
        { status: 500 }
      );
    }

    if (responseMode === 'run') {
      return NextResponse.json({ runId: run.runId });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const reader = run.readable.getReader();

          // Start reading the stream
          const readLoop = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                controller.enqueue(value);
              }
            }
          };

          // Race between stream completion and workflow completion
          await Promise.race([readLoop(), run.returnValue]);

          // Give a moment for any final stream data
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Close the stream
          reader.releaseLock();
          controller.close();
        } catch (error) {
          console.error('Error in workflow stream:', error);
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Workflow-Run-Id': run.runId,
      },
    });
  } catch (error) {
    console.error('Error starting workflow:', error);
    return NextResponse.json(
      {
        error: 'Failed to start workflow',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
