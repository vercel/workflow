import { start } from 'workflow/api';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { allWorkflows } from '../../_workflows.js';

export default async ({ req, url }: { req: Request; url: URL }) => {
  const workflowFile =
    url.searchParams.get('workflowFile') || 'workflows/99_e2e.ts';
  if (!workflowFile) {
    return new Response('No workflowFile query parameter provided', {
      status: 400,
    });
  }
  const workflows = allWorkflows[workflowFile as keyof typeof allWorkflows];
  if (!workflows) {
    return new Response(`Workflow file "${workflowFile}" not found`, {
      status: 400,
    });
  }

  const workflowFn = url.searchParams.get('workflowFn') || 'simple';
  if (!workflowFn) {
    return new Response('No workflow query parameter provided', {
      status: 400,
    });
  }

  // Handle static method lookups (e.g., "Calculator.calculate")
  let workflow: unknown;
  if (workflowFn.includes('.')) {
    const [className, methodName] = workflowFn.split('.');
    const cls = workflows[className as keyof typeof workflows];
    if (cls && typeof cls === 'function') {
      workflow = (cls as Record<string, unknown>)[methodName];
    }
  } else {
    workflow = workflows[workflowFn as keyof typeof workflows];
  }
  if (!workflow) {
    return new Response(`Workflow "${workflowFn}" not found`, { status: 400 });
  }

  let args: any[] = [];

  // Args from query string
  const argsParam = url.searchParams.get('args');
  if (argsParam) {
    args = argsParam.split(',').map((arg) => {
      const num = parseFloat(arg);
      return Number.isNaN(num) ? arg.trim() : num;
    });
  } else {
    // Args from body
    const body = await req.text();
    if (body) {
      args = hydrateWorkflowArguments(JSON.parse(body), globalThis);
    } else {
      args = [42];
    }
  }
  console.log(`Starting "${workflowFn}" workflow with args: ${args}`);

  try {
    const run = await start(workflow as any, args as any);
    console.log('Run:', run.runId);
    return Response.json(run);
  } catch (err) {
    console.error(`Failed to start!!`, err);
    throw err;
  }
};
