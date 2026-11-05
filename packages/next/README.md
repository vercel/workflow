# @workflow/next

Next.js plugin for [Workflow SDK](https://workflow-sdk.dev).

Configure the Vercel function that executes workflows and steps with the second
argument to `withWorkflow`:

```ts
withWorkflow(nextConfig, {
  workflows: { maxDuration: 300 },
});
```

`maxDuration` accepts a positive integer in seconds or `'max'` (the default).
It configures each function invocation, not the lifetime of a durable workflow.
Vercel's plan and project limits still apply. See the
[configuration reference](https://workflow-sdk.dev/docs/api-reference/workflow-next/with-workflow#function-duration)
for runtime ownership constraints when increasing the limit.
