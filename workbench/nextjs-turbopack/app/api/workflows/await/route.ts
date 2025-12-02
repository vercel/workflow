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

    // Await the result
    const result = await run.returnValue;

    return NextResponse.json({
      runId,
      status: 'completed',
      result,
    });
  } catch (error) {
    console.error('Error awaiting workflow:', error);
    return NextResponse.json(
      {
        error: 'Failed to await workflow',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
