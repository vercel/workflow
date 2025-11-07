---
"@workflow/ai": patch
---

Add stopWhen property to DurableAgent for AI SDK compatibility. The DurableAgent class now supports the stopWhen option, making it compatible with AI SDK's interface for controlling when agent execution should stop. This can be configured in the constructor or when calling the stream method, accepting either a single StopCondition or an array of conditions.
