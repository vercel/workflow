---
"@workflow/ai": patch
---

Mark every public `@workflow/ai` export as deprecated, including the provider wrappers, test models and `normalizeUIMessageStreamParts`, and point each to its `@ai-sdk/workflow` or `ai/test` replacement. Correct the README: `@workflow/ai` supports AI SDK 6 only (`ai@^6`), so install `ai@6` alongside it.
