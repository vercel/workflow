import { defineEventHandler, readRawBody } from 'h3';
import { getHookByToken, resumeHook } from 'workflow/api';

export default defineEventHandler(async (event) => {
  const body = await readRawBody(event);
  const { token, data } = JSON.parse(body as string);

  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(token);
    console.log('hook', hook);
  } catch (error) {
    console.log('error during getHookByToken', error);
    // TODO: `WorkflowAPIError` is not exported, so for now
    // we'll return 404 assuming it's the "invalid" token test case
    return Response.json(null, { status: 404 });
  }

  await resumeHook(hook.token, {
    ...data,
    // @ts-expect-error metadata is not typed
    customData: hook.metadata?.customData,
  });

  return Response.json(hook);
});
