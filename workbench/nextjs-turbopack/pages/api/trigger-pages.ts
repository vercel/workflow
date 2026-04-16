import type { NextApiRequest, NextApiResponse } from 'next';

function getBaseUrl(req: NextApiRequest): string {
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(protoHeader)
    ? protoHeader[0]
    : protoHeader || 'http';
  const host = req.headers.host;
  if (!host) {
    throw new Error('Missing host header');
  }
  return `${proto}://${host}`;
}

async function proxyJson(
  req: NextApiRequest,
  path: string,
  body: unknown
): Promise<Response> {
  return fetch(new URL(path, getBaseUrl(req)), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'POST') {
    return handlePost(req, res);
  } else if (req.method === 'GET') {
    return handleGet(req, res);
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const workflowFile =
    (req.query.workflowFile as string) || 'workflows/99_e2e.ts';
  if (!workflowFile) {
    return res.status(400).send('No workflowFile query parameter provided');
  }
  const workflowFn = (req.query.workflowFn as string) || 'simple';
  if (!workflowFn) {
    return res.status(400).send('No workflow query parameter provided');
  }

  let args: any[] = [];

  // Args from query string
  const argsParam = req.query.args as string | undefined;
  if (argsParam) {
    args = argsParam.split(',').map((arg) => {
      const num = parseFloat(arg);
      return Number.isNaN(num) ? arg.trim() : num;
    });
  } else if (req.body && Array.isArray(req.body)) {
    // Args from JSON body
    args = req.body;
  } else {
    args = [];
  }
  console.log(`Starting "${workflowFn}" workflow with args: ${args}`);

  try {
    const response = await proxyJson(req, '/api/workflows/start', {
      workflowFile,
      workflowFn,
      args,
      responseMode: 'run',
    });
    const text = await response.text();
    return res
      .status(response.status)
      .setHeader('Content-Type', 'application/json')
      .send(text);
  } catch (err) {
    console.error(`Failed to start!!`, err);
    throw err;
  }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const runId = req.query.runId as string | undefined;
  if (!runId) {
    return res.status(400).send('No runId provided');
  }

  const outputStreamParam = req.query['output-stream'] as string | undefined;
  if (outputStreamParam) {
    const namespace = outputStreamParam === '1' ? undefined : outputStreamParam;
    const response = await proxyJson(req, '/api/workflows/stream', {
      runId,
      namespace,
    });
    if (!response.ok || !response.body) {
      return res.status(response.status).send(await response.text());
    }

    res.setHeader(
      'Content-Type',
      response.headers.get('Content-Type') || 'application/octet-stream'
    );

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return res.end();
  }

  try {
    const response = await proxyJson(req, '/api/workflows/await', { runId });
    const result = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(result);
    }
    return res.status(200).json(result.result);
  } catch (error) {
    console.error(
      'Unexpected error while getting workflow return value:',
      error
    );
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
}
