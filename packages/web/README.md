# @workflow/web

Observability Web UI Package bundled in the [Workflow DevKit](https://useworkflow.dev/docs/observability).

## Self-hosting

While this UI is bundled with the Workflow CLI, you can also self-host it by cloning this repository and
deploying it like any other NextJS app.

For API calls to work, you'll need to pass the same environment variables to the NextJS app that are
used by the Workflow CLI. See `npx workflow inspect --help` for more information on the available environment variables.


If you're deploying to Vercel:
1. Set the project root directory to `packages/web`
1. Fill in environment variables in the Vercel UI
1. Ensure `WORKFLOW_TARGET_WORLD` is to `vercel`

The UI will not connect to your backend by default. 

4. In the UI, go Settings -> Configuration -> Backend -> select `vercel`. 

Once the backend is set, the rest of the env vars will be inferred.

> [!NOTE]
> Setting any of the fields via the UI's configuration tab will append them as query params in the URL, which risks exposing your credentials when operating over the internet. If your env vars are set, you **only** need to set the `Backend` field in the UI.

Note that observability will be scoped to the project
and environment you're deploying to.
