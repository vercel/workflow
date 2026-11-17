import { getRun } from 'workflow/api';

// Bundling probe: a run's status and, once completed, its return value.
export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get('runId');
  if (!runId) return Response.json({ error: 'runId' }, { status: 400 });
  const run = getRun(runId);
  const status = await run.status;
  const value = status === 'completed' ? await run.returnValue : undefined;
  return Response.json({ runId, status, value });
}
