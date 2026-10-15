# @workflow/next

Next.js plugin for [Workflow SDK](https://workflow-sdk.dev).

Applications can derive deployment metadata after each successful workflow
bundle by passing `onAfterBundle` to `withWorkflow`:

```ts
import { withWorkflow } from '@workflow/next'

export default withWorkflow(nextConfig, {
  workflows: {
    onAfterBundle: ({ artifacts }) => {
      // Derive deployment metadata from artifacts here.
      void artifacts
    }
  }
})
```
