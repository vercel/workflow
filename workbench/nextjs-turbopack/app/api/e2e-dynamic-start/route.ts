import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import {
  dynamicWorkflowDisallowedStep,
  dynamicWorkflowFromApp,
  dynamicWorkflowFromAppWithSleep,
} from '@/workflows/99_e2e';

/**
 * Starts one of the dynamic-workflow e2e fixtures from inside the app.
 *
 * The e2e runner otherwise calls `start()` in its own process. Starting the
 * run here makes the app's own queue the sender, as in a real app, for the
 * dynamic-workflow lane, which runs with queue auth on
 * (`e2e-dynamic-workflow.test.ts`, `WORKFLOW_E2E_START_VIA_APP=1`). Limited
 * to the fixtures that lane starts.
 */
const FIXTURES = {
  dynamicWorkflowFromApp,
  dynamicWorkflowFromAppWithSleep,
  dynamicWorkflowDisallowedStep,
} as const;

export async function POST(req: Request) {
  const { fixture, args } = (await req.json()) as {
    fixture: string;
    args?: unknown[];
  };
  const workflow = Object.hasOwn(FIXTURES, fixture)
    ? FIXTURES[fixture as keyof typeof FIXTURES]
    : undefined;
  if (!workflow) {
    return NextResponse.json(
      { error: `Unknown fixture "${fixture}"` },
      { status: 404 }
    );
  }
  const [value] = (args ?? []) as [number];
  const run = await start(workflow, [value]);
  return NextResponse.json({ runId: run.runId });
}
