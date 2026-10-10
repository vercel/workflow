# @workflow/nuxt

Nuxt module for [Workflow SDK](https://workflow-sdk.dev).

Monorepo workspace package imports work without extra workflow config because `workflow/nuxt` runs through Nitro's detected `workspaceDir`.

Applications can derive deployment metadata after each successful workflow
bundle by passing `onAfterBundle` in the Nuxt module options:

```ts
export default defineNuxtConfig({
  modules: ['@workflow/nuxt'],
  workflow: {
    onAfterBundle: ({ artifacts }) => {
      // Derive deployment metadata from artifacts here.
      void artifacts
    }
  }
})
```
