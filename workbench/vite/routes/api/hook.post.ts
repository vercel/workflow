import { getHookByToken, resumeHook } from "workflow/api";

export default async ({ req }: { req: Request }) => {
  const { token, data } = await req.json();

  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(token);
    console.log("hook", hook);
  } catch (error) {
    console.log("error during getHookByToken", error);
    // TODO: `WorkflowAPIError` is not exported, so for now
    // we'll return 422 assuming it's the "invalid" token test case
    // NOTE: Need to return 422 because Nitro passes 404 requests to the dev server to handle.
    return Response.json(null, { status: 422 });
  }

  await resumeHook(hook.token, {
    ...data,
    // @ts-expect-error metadata is not typed
    customData: hook.metadata?.customData,
  });

  return Response.json(hook);
};
