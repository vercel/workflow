import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { getHookByToken, resumeHook } from 'workflow/api';

export const Route = createFileRoute('/api/hook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { token, data } = await request.json();

        let hook: Awaited<ReturnType<typeof getHookByToken>>;
        try {
          hook = await getHookByToken(token);
          console.log('hook', hook);
        } catch (error) {
          console.log('error during getHookByToken', error);
          // TODO: `WorkflowAPIError` is not exported, so for now
          // we'll return 422 assuming it's the "invalid" token test case
          // NOTE: Need to return 422 because Nitro passes 404 requests to the dev server to handle.
          return json(null, { status: 422 });
        }

        await resumeHook(hook.token, {
          ...data,
          // @ts-expect-error metadata is not typed
          customData: hook.metadata?.customData,
        });

        return json(hook);
      },
    },
  },
});
