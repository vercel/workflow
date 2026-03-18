# Plan: Preserve reasoning content in DurableAgent conversation history

Closes #1393

## Problem

When DurableAgent's tool loop continues to the next step, the assistant message pushed to `conversationPrompt` only contains `tool-call` parts. Reasoning content (from OpenAI o-series, Anthropic extended thinking, Gemini thinking) is omitted, even though the AI SDK's own `streamText` preserves it via `toResponseMessages()`.

This means reasoning models lose access to their prior reasoning during multi-step tool loops, degrading quality.

## Key Files

1. **`packages/ai/src/agent/stream-text-iterator.ts`** — where assistant messages are built for the conversation prompt
2. **`packages/ai/src/agent/do-stream-step.ts`** — `chunksToStep()` already collects reasoning chunks into `StepResult`
3. **`packages/ai/src/agent/stream-text-iterator.test.ts`** — unit tests for the iterator

## Changes

### 1. Include reasoning parts in assistant message (`stream-text-iterator.ts`)

In the `finishReason === 'tool-calls'` branch (line 298-322), the assistant message currently only contains tool-call parts. We need to prepend reasoning content parts before the tool-call parts.

The reasoning data is available from the `step` result (which `doStreamStep` returns). We extract `step.reasoning` and map each reasoning part to a `{ type: 'reasoning', text, providerOptions }` content part, then prepend them to the tool-call parts in the assistant message.

```typescript
// Before (current code):
conversationPrompt.push({
  role: 'assistant',
  content: toolCalls.map((toolCall) => { ... }),
});

// After:
const reasoningParts = (step.reasoning ?? []).map((r) => ({
  type: 'reasoning' as const,
  text: r.text,
  ...(r.providerOptions != null ? { providerOptions: r.providerOptions } : {}),
}));

conversationPrompt.push({
  role: 'assistant',
  content: [
    ...reasoningParts,
    ...toolCalls.map((toolCall) => { ... }),
  ],
});
```

### 2. Remove `sanitizeProviderMetadataForToolCall` and OpenAI `itemId` stripping (`stream-text-iterator.ts`)

With reasoning items now preserved in the conversation, OpenAI's `itemId` references become valid. The `sanitizeProviderMetadataForToolCall` function (lines 489-519) and its usage (lines 309-311) can be removed.

The tool-call mapping simplifies to passing `providerMetadata` directly as `providerOptions` without sanitization.

### 3. Add tests (`stream-text-iterator.test.ts`)

Add tests verifying:
- Reasoning parts are included in the assistant message before tool-call parts
- Multiple reasoning parts are preserved
- Empty reasoning (no reasoning content) doesn't add extra parts
- OpenAI `itemId` is now preserved (update existing test that expects it to be stripped)

### 4. Changeset

Create a patch changeset for `@workflow/ai`.

## What NOT to change

- `do-stream-step.ts` — already collects reasoning correctly, no changes needed
- `durable-agent.ts` — no changes needed, it receives step results from the iterator
- The `finishReason === 'stop'` branch — for stop, only text content is added (reasoning on final response is less critical for multi-turn, but could be a follow-up)

## Verification

- Run existing tests: `cd packages/ai && pnpm test`
- Verify new tests pass
- Build: `cd packages/ai && pnpm build`
