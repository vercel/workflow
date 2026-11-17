---
'@workflow/web-shared': minor
---

Remove dead code, every export that nothing imports, and the unused `@workflow/web-shared/components` entry point (import from the package root instead). Removed exports include `hydrateResourceIOWithKey` (use `hydrateResourceIOAsync`), `MenuDropdown`, the `materialize*` helpers, `shouldShowReenqueueButton`, `hasPendingStepsFromEvents`, `hasPendingHooksFromEvents`, `isTerminalStatus`, `identifyStreamSteps`, `looksLikeWorkflowIdSearchInput`, the ref helpers re-exported from `@workflow/core/serialization-format`, and internal components and hooks such as `Kbd`, `IconButton`, `LoadMoreButton` and `useToast`.
