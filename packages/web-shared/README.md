# @workflow/web-shared

Workflow Observability tools for NextJS. See [Workflow DevKit](https://useworkflow.dev/docs/observability) for more information.

## Usage

This package contains client and server code to interact with the Workflow API, as well as some pre-styled components.
If you want to deploy a full observability experience with your NextJS app, take a look at [`@workflow/web`](../web/README.md) instead, which can be self-hosted.

You can use the API to create your own display UI, like so:

```tsx
import { useWorkflowRuns } from '@workflow/web-shared';

export default function MyRunsList() {
  const {
    data,
    error,
    nextPage,
    previousPage,
    hasNextPage,
    hasPreviousPage,
    reload,
    pageInfo,
  } = useWorkflowRuns(env, {
    sortOrder,
    workflowName: workflowNameFilter === 'all' ? undefined : workflowNameFilter,
    status: status === 'all' ? undefined : status,
  });

  // Shows an interactive trace viewer for the given run
  return <div>{runs.map((run) => (
    <div key={run.runId}>
      {run.workflowName}
      {run.status}
      {run.startedAt}
      {run.completedAt}
    </div>
  ))}</div>;
}
```

It also comes with a pre-styled interactive trace viewer that you can use to display the trace for a given run:

```tsx
import { RunTraceView } from '@workflow/web-shared';

export default function MyRunDetailView({ env, runId }: { env: EnvMap, runId: string }) {
  // ... your other code

  // Shows an interactive trace viewer for the given run
  return <RunTraceView env={env} runId={runId} />;
}
```

## Environment Variables

For API calls to work, you'll need to pass the same environment variables that are used by the Workflow CLI.
See `npx workflow inspect --help` for more information.

If you're deploying this as part of your Vercel NextJS app, setting `WORKFLOW_TARGET_WORLD` to `vercel` is enough
to infer your other project details from the Vercel environment variables.

## Styling

In order for tailwind classes to be picked up correctly, you might need to configure your NextJS app
to use the correct CSS processor. E.g. if you're using PostCSS with TailwindCSS, you can do the following:

```tsx
// postcss.config.mjs in your NextJS app
const config = {
  plugins: ['@tailwindcss/postcss'],
};

export default config;
```
