import express from 'express';
import { toFetchHandler } from 'srvx/node';
import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { allWorkflows } from '../_workflows.js';

const app = express();

app.use(express.json());
app.use(express.text({ type: 'text/*' }));

app.post('/api/hook', async (req, res, _) => {
  const { token, data } = JSON.parse(req.body);

  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(token);
  } catch (error) {
    console.log('error during getHookByToken', error);
    // TODO: `WorkflowAPIError` is not exported, so for now
    // we'll return 404 assuming it's the "invalid" token test case
    return res.status(404).json(null);
  }

  await resumeHook(hook.token, {
    ...data,
    // @ts-expect-error metadata is not typed
    customData: hook.metadata?.customData,
  });

  return res.json(hook);
});

export default toFetchHandler(app as any);
