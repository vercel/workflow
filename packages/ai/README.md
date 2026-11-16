# @workflow/ai

A helper library that makes [Workflow SDK](https://workflow-sdk.dev) compatible with the [AI SDK](https://ai-sdk.dev/).

> [!WARNING]
> `@workflow/ai` is deprecated. For new code, use AI SDK's [`WorkflowAgent`](https://ai-sdk.dev/v7/docs/agents/workflow-agent#workflowagent) and `WorkflowChatTransport` from [`@ai-sdk/workflow`](https://www.npmjs.com/package/@ai-sdk/workflow), which require AI SDK 7. See the [migration guide](https://ai-sdk.dev/v7/docs/agents/workflow-agent#migrating-from-durableagent).

## AI SDK compatibility

This package supports **AI SDK 6** only. The `ai` package is a peer dependency (`ai@^6`), so install version 6 explicitly; a plain `npm install ai` installs AI SDK 7, which this package does not support:

```bash
npm install @workflow/ai ai@6
```

### Provider packages

If you use the provider wrappers (for example `@workflow/ai/anthropic` or `@workflow/ai/openai`), install the AI SDK 6 provider packages (`@ai-sdk/*@3`):

```bash
npm install ai@6 @ai-sdk/anthropic@3
```

## Documentation

For usage examples and full documentation, see the [API reference](https://workflow-sdk.dev/docs/api-reference/workflow-ai/).
