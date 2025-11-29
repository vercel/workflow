import { getRun } from 'workflow/api';
import {
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
} from 'workflow/internal/errors';

export default async ({ url }: { req: Request; url: URL }) => {
  const runId = url.searchParams.get('runId');
  if (!runId) {
    return new Response('No runId provided', { status: 400 });
  }

  const outputStreamParam = url.searchParams.get('output-stream');
  if (outputStreamParam) {
    const namespace = outputStreamParam === '1' ? undefined : outputStreamParam;
    const run = getRun(runId);
    const stream = run.getReadable({
      namespace,
    });
    // Add JSON framing to the stream, wrapping binary data in base64
    const streamWithFraming = new TransformStream({
      transform(chunk, controller) {
        const data =
          chunk instanceof Uint8Array
            ? { data: Buffer.from(chunk).toString('base64') }
            : chunk;
        controller.enqueue(`${JSON.stringify(data)}\n`);
      },
    });
    return new Response(stream.pipeThrough(streamWithFraming), {
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });
  }

  try {
    const run = getRun(runId);
    const returnValue = await run.returnValue;
    console.log('Return value:', returnValue);

    // Include run metadata in headers
    const [createdAt, startedAt, completedAt] = await Promise.all([
      run.createdAt,
      run.startedAt,
      run.completedAt,
    ]);
    const headers: HeadersInit =
      returnValue instanceof ReadableStream
        ? { 'Content-Type': 'application/octet-stream' }
        : {};

    headers['X-Workflow-Run-Created-At'] = createdAt?.toISOString() || '';
    headers['X-Workflow-Run-Started-At'] = startedAt?.toISOString() || '';
    headers['X-Workflow-Run-Completed-At'] = completedAt?.toISOString() || '';

    return returnValue instanceof ReadableStream
      ? new Response(returnValue, { headers })
      : Response.json(returnValue, { headers });
  } catch (error) {
    if (error instanceof Error) {
      if (WorkflowRunNotCompletedError.is(error)) {
        return Response.json(
          {
            ...error,
            name: error.name,
            message: error.message,
          },
          { status: 202 }
        );
      }

      if (WorkflowRunFailedError.is(error)) {
        const cause = error.cause;
        return Response.json(
          {
            ...error,
            name: error.name,
            message: error.message,
            cause: {
              message: cause.message,
              stack: cause.stack,
              code: cause.code,
            },
          },
          { status: 400 }
        );
      }
    }

    console.error(
      'Unexpected error while getting workflow return value:',
      error
    );
    return Response.json(
      {
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
};
