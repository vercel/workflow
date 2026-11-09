# @workflow/ai

`WorkflowChatTransport` for [Workflow SDK](https://workflow-sdk.dev) apps on [AI SDK](https://ai-sdk.dev/) 6.

> [!WARNING]
> `@workflow/ai` is deprecated. Use AI SDK's [`WorkflowAgent`](https://ai-sdk.dev/v7/docs/agents/workflow-agent#workflowagent) and `WorkflowChatTransport` from [`@ai-sdk/workflow`](https://www.npmjs.com/package/@ai-sdk/workflow), which require AI SDK 7.
>
> `@workflow/ai` 6 contains only `WorkflowChatTransport`. `DurableAgent` (`@workflow/ai/agent`), the provider wrappers (`@workflow/ai/openai` and the others) and `@workflow/ai/test` are in `@workflow/ai` 5 and earlier. To move an agent off `DurableAgent`, follow the [migration guide](https://ai-sdk.dev/v7/docs/agents/workflow-agent#migrating-from-durableagent).

## AI SDK compatibility

This package supports **AI SDK 6** only. The `ai` package is a peer dependency (`ai@^6`), so install version 6 explicitly; a plain `npm install ai` installs AI SDK 7, which this package does not support:

```bash
npm install @workflow/ai ai@6
```

## Documentation

See the [`WorkflowChatTransport` reference](https://workflow-sdk.dev/docs/api-reference/workflow-ai/workflow-chat-transport).
