import { getRun } from 'workflow/api';
import { getWorld } from 'workflow/runtime';

/**
 * A run's outcome and event log, read by this deployment, for
 * packages/core/e2e/e2e-inline-start.test.ts. Waits up to `waitMs` (default
 * 60s) for the run to finish. Answers `{ status, completedAt, returnValue,
 * events: [{ eventType, correlationId, createdAt }] }`.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const waitMs = Number(new URL(req.url).searchParams.get('waitMs') ?? 60_000);
  const run = getRun(runId);
  const returnValue = await Promise.race([
    run.returnValue.catch((error: unknown) => ({ error: String(error) })),
    new Promise((resolve) => setTimeout(() => resolve(undefined), waitMs)),
  ]);
  const world = await getWorld();
  const [entity, page] = await Promise.all([
    world.runs.get(runId),
    world.events.list({
      runId,
      resolveData: 'none',
      pagination: { limit: 1000, sortOrder: 'asc' },
    }),
  ]);
  return Response.json({
    status: entity.status,
    completedAt: entity.completedAt?.getTime() ?? null,
    returnValue: returnValue ?? null,
    events: page.data.map((e) => ({
      eventType: e.eventType,
      correlationId: e.correlationId ?? null,
      createdAt: new Date(e.createdAt).getTime(),
    })),
  });
}
