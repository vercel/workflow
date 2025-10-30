# @workflow/web

Observability Web UI Package bundled in the [Workflow DevKit](https://useworkflow.dev/docs/observability).

## Self-hosting

While this UI is bundled with the Workflow CLI, you can also self-host it by cloning this repository and
deploying it like any other NextJS app.

For API calls to work, you'll need to pass the same environment variables to the NextJS app that are
used by the Workflow CLI. See `npx workflow inspect --help` for more information on the available environment variables.

If you're deploying this to Vercel, setting `WORKFLOW_TARGET_WORLD` to `vercel` is enough
to infer your other project details. Note that observability will be scoped to the project
and environment you're deploying to.
