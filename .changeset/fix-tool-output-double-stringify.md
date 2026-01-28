---
"@workflow/ai": patch
---

Fix double-serialization of tool output in writeToolOutputToUI. The function was JSON.stringify-ing the entire LanguageModelV2ToolResultPart object instead of extracting the actual tool output value.
