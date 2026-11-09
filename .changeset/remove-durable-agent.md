---
"@workflow/ai": major
---

Remove `DurableAgent` and the exports that only served it: `@workflow/ai/agent`, the provider wrappers (`@workflow/ai/anthropic`, `/gateway`, `/google`, `/openai`, `/xai`) and `@workflow/ai/test`. `@workflow/ai` keeps the deprecated `WorkflowChatTransport`, and no longer needs `workflow` as a peer dependency. Use AI SDK's `WorkflowAgent` from `@ai-sdk/workflow`; see the [migration guide](https://ai-sdk.dev/v7/docs/agents/workflow-agent#migrating-from-durableagent).
