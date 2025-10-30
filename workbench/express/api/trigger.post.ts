import express from 'express';
import { toFetchHandler } from 'srvx/node';
import { start } from 'workflow/api';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { allWorkflows } from '../_workflows.js';

const app = express();

app.use(express.json());
app.use(express.text({ type: 'text/*' }));

app.post('/api/trigger', async (req, res, _) => {
  const workflowFile =
    (req.query.workflowFile as string) || 'workflows/99_e2e.ts';
  if (!workflowFile) {
    return res.status(400).json({
      error: 'No workflowFile query parameter provided',
      status: 400,
    });
  }
  const workflows = allWorkflows[workflowFile as keyof typeof allWorkflows];
  if (!workflows) {
    return res.status(400).json({
      error: `Workflow file "${workflowFile}" not found`,
      status: 400,
    });
  }

  const workflowFn = (req.query.workflowFn as string) || 'simple';
  if (!workflowFn) {
    return res.status(400).json({
      error: 'No workflow query parameter provided',
      status: 400,
    });
  }
  const workflow = workflows[workflowFn as keyof typeof workflows];
  if (!workflow) {
    return res.status(400).json({
      error: `Workflow "${workflowFn}" not found`,
      status: 400,
    });
  }

  let args: any[] = [];

  // Args from query string
  const argsParam = req.query.args as string;
  if (argsParam) {
    args = argsParam.split(',').map((arg) => {
      const num = parseFloat(arg);
      return Number.isNaN(num) ? arg.trim() : num;
    });
  } else {
    if (req.body) {
      args = hydrateWorkflowArguments(JSON.parse(req.body), globalThis);
    } else {
      args = [42];
    }
  }
  console.log(`Starting "${workflowFn}" workflow with args: ${args}`);

  try {
    const run = await start(workflow as any, args as any);
    console.log('Run:', run);
    return res.json(run);
  } catch (err) {
    console.error(`Failed to start!!`, err);
    throw err;
  }
});

export default toFetchHandler(app as any);
