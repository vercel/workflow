import { start } from 'workflow/api';
import { virtualModuleWorkflow } from '../../virtual-module/workflow.js';

export default async () => {
  const run = await start(virtualModuleWorkflow, []);
  return Response.json({
    runId: run.runId,
    returnValue: await run.returnValue,
  });
};
