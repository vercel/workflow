# workflow/astro

The docs have moved! Refer to them [here](https://workflow-sdk.dev/)

Applications can derive deployment metadata after each successful workflow
bundle by passing `onAfterBundle` to `workflow()`:

```ts
import { workflow } from '@workflow/astro'

export default {
  integrations: [
    workflow({
      onAfterBundle: ({ artifacts }) => {
        // Derive deployment metadata from artifacts here.
        void artifacts
      }
    })
  ]
}
```
