import express from 'express';
import { toFetchHandler } from 'srvx/node';
import { getRun } from 'workflow/api';

const app = express();

app.use(express.json());
app.use(express.text({ type: 'text/*' }));

app.get('/api/trigger', async (req, res, _) => {
  const runId = req.query.runId as string;
  if (!runId) {
    return res.status(400).json({
      error: 'No runId provided',
      status: 400,
    });
  }

  const outputStreamParam = req.query['output-stream'] as string;
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
    const transformedStream = stream.pipeThrough(streamWithFraming);
    res.setHeader('Content-Type', 'application/octet-stream');

    const reader = transformedStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (error) {
      reader.releaseLock();
      throw error;
    }
    return;
  }

  try {
    const run = getRun(runId);
    const returnValue = await run.returnValue;
    console.log('Return value:', returnValue);
    if (returnValue instanceof ReadableStream) {
      res.setHeader('Content-Type', 'application/octet-stream');

      const reader = returnValue.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } catch (error) {
        reader.releaseLock();
        throw error;
      }
      return;
    }
    return res.json(returnValue);
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'WorkflowRunNotCompletedError') {
        return res.status(202).json({
          ...error,
          name: error.name,
          message: error.message,
        });
      }

      if (error.name === 'WorkflowRunFailedError') {
        return res.status(400).json({
          ...error,
          name: error.name,
          message: error.message,
        });
      }
    }

    console.error(
      'Unexpected error while getting workflow return value:',
      error
    );
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

export default toFetchHandler(app as any);
