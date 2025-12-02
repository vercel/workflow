import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getRun } from 'workflow/api';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { runId } = body as { runId: string };

    if (!runId) {
      return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    }

    // Get the workflow run
    const run = await getRun(runId);

    if (!run) {
      return NextResponse.json(
        { error: `Workflow run "${runId}" not found` },
        { status: 404 }
      );
    }

    // Get the stream if the run has a stream method
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runObj = run as any;
    let stream: ReadableStream | null = null;
    if (typeof runObj.stream === 'function') {
      try {
        stream = runObj.stream();
      } catch (error) {
        console.error('Error calling run.stream():', error);
      }
    }

    if (!stream) {
      return NextResponse.json(
        { error: 'Stream not available for this run' },
        { status: 404 }
      );
    }

    // Create a response with the stream
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Workflow-Run-Id': runId,
      },
    });
  } catch (error) {
    console.error('Error resuming stream:', error);
    return NextResponse.json(
      {
        error: 'Failed to resume stream',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
