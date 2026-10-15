# workflow/nitro

The docs have moved! Refer to them [here](https://workflow-sdk.dev/)

The Nitro module uses Nitro's `workspaceDir` as the workflow project root, so monorepo apps can import sibling workspace packages without extra workflow config.

Applications can derive deployment metadata at the bundle boundary by passing
an `onAfterBundle` hook through `nitro.options.workflow`:

```ts
export default defineNitroConfig({
  workflow: {
    onAfterBundle: ({ artifacts }) => {
      // Derive deployment metadata from artifacts here.
      void artifacts
    }
  }
})
```
