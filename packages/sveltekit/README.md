# workflow/sveltekit

The docs have moved! Refer to them [here](https://workflow-sdk.dev/)

Applications can derive deployment metadata after each successful workflow
bundle by passing `onAfterBundle` to `workflow()`:

```ts
import { workflow } from '@workflow/sveltekit'

export default {
  kit: {
    vite: {
      plugins: [
        workflow({
          onAfterBundle: ({ artifacts }) => {
            // Derive deployment metadata from artifacts here.
            void artifacts
          }
        })
      ]
    }
  }
}
```
