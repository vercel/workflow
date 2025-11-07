import { getHookByToken, resumeHook, WorkflowAPIError } from 'workflow/api';

export const POST = async (request: Request) => {
  const { token, data } = await request.json();

  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(token);
    console.log('hook', hook);
  } catch (error) {
    console.log('error during getHookByToken', error);
    if (error instanceof WorkflowAPIError && error.status === 404) {
      return Response.json(null, { status: 404 });
    }
    throw error;
  }

  await resumeHook(hook.token, {
    ...data,
    // @ts-expect-error metadata is not typed
    customData: hook.metadata?.customData,
  });

  return Response.json(hook);
};
