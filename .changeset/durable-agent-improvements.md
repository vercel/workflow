---
'@workflow/ai': patch
---

Add type helpers (`InferDurableAgentTools`, `InferDurableAgentUIMessage`), support `prepareStep` on `DurableAgent` constructor, fix `supportedUrls` causing `AI_DownloadError` for image URLs, and add telemetry span support for `experimental_telemetry`. Fix `LanguageModelV3ToolResultOutput` breaking response when not json compatible.
