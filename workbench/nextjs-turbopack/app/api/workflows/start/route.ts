import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { allWorkflows } from '@/_workflows';
import {
  WORKFLOW_DEFINITIONS,
  type WorkflowName,
} from '@/app/workflows/definitions';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { workflowName, args } = body as {
      workflowName: WorkflowName;
      args?: unknown[];
    };

    // Find workflow definition
    const definition = WORKFLOW_DEFINITIONS.find(
      (w) => w.name === workflowName
    );
    if (!definition) {
      return NextResponse.json(
        { error: `Workflow "${workflowName}" not found` },
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
    const workflowFn = workflows[
      workflowName as keyof typeof workflows
    ] as () => Promise<unknown>;
    if (typeof workflowFn !== 'function') {
      return NextResponse.json(
        { error: `Workflow "${workflowName}" is not a function` },
        { status: 400 }
      );
    }

    // Use provided args or default args
    const workflowArgs = args !== undefined ? args : definition.defaultArgs;

    // Start the workflow
    // @ts-expect-error - we're doing arbitrary calls to unknown functions
    const run = await start(workflowFn, workflowArgs);

    if (!run) {
      return NextResponse.json(
        { error: 'Failed to get workflow run' },
        { status: 500 }
      );
    }

    // Create a stream that properly closes when workflow completes

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
