# @workflow/ai

[Workflow DevKit](https://useworkflow.dev) compatible helper library for the [AI SDK](https://ai-sdk.dev/).

## Installation

```bash
npm install @workflow/ai
```

## AI SDK Compatibility

This package supports both **AI SDK v5** and **AI SDK v6**. The `ai` package is a peer dependency, so you control which version to use:

```bash
# For AI SDK v6 (recommended, latest)
npm install ai

# For AI SDK v5
npm install ai@5
```

### Version Differences

| Feature | AI SDK v5 | AI SDK v6 |
|---------|-----------|-----------|
| Model interface | `LanguageModelV2` | `LanguageModelV3` |
| Provider package | `@ai-sdk/provider@2.x` | `@ai-sdk/provider@3.x` |

Both versions work seamlessly with `@workflow/ai` - the package handles the differences internally through a compatibility layer.

### Provider Packages

If you use the provider wrappers (e.g., `@workflow/ai/anthropic`, `@workflow/ai/openai`), install the corresponding provider packages:

```bash
# Example: Using Anthropic with AI SDK v6
npm install ai @ai-sdk/anthropic

# Example: Using OpenAI with AI SDK v5
npm install ai@5 @ai-sdk/openai@2
```

## Usage

```typescript
import { DurableAgent } from '@workflow/ai/agent';

const agent = new DurableAgent({
  model: 'anthropic/claude-sonnet-4.5',
  system: 'You are a helpful assistant.',
  tools: {
    // your tools here
  },
});

await agent.stream({
  messages: [{ role: 'user', content: 'Hello!' }],
  writable: getWritable(),
});
```
