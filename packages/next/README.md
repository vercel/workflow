# @workflow/next

Next.js plugin for [Workflow SDK](https://workflow-sdk.dev).

Applications can derive deployment metadata after each successful workflow
bundle by passing `onAfterBundle` to `withWorkflow`:

```ts
import type { NextConfig } from 'next'
import { withWorkflow } from '@workflow/next'

const nextConfig: NextConfig = {}

export default withWorkflow(nextConfig, {
  workflows: {
    onAfterBundle: ({ artifacts }) => {
      // Derive deployment metadata from artifacts here.
      void artifacts
    }
  }
})
```
