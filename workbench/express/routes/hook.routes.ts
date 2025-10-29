import express from 'express';
import { getHookByToken, resumeHook } from 'workflow/api';

const hookRouter = express.Router();

hookRouter.post('/api/hook', async (req, res, _) => {
  const { token, data } = await req.body;

  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(token);
    console.log('hook', hook);
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

export default hookRouter;
