# AI Agents with Workflow

Build durable AI agents that survive restarts and stream responses.

## Installation

```bash
npm i @workflow/ai ai
```

Supports AI SDK v5 and v6.

## DurableAgent

Creates AI agents that maintain state across workflow steps:

```typescript
import { DurableAgent } from "@workflow/ai/agent";
import { fetch, getWritable } from "workflow";
import { z } from "zod";

const agent = new DurableAgent({
  model: "anthropic/claude-haiku-4.5",
  system: "You are a helpful assistant.",
  temperature: 0.7,
  maxSteps: 10,
  tools: {
    searchWeb: {
      description: "Search the web for information",
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        "use step";
        return await webSearch(query);
      },
    },
    getWeather: {
      description: "Get current weather",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        "use step";
        return await weatherAPI.get(city);
      },
    },
  },
});

export async function chatWorkflow(messages: Message[]) {
  "use workflow";
  globalThis.fetch = fetch;  // Required for AI SDK

  const writable = getWritable();
  const result = await agent.stream({
    messages,
    writable,
  });

  return result.messages;
}
```

## DurableAgent Options

| Option | Type | Description |
|--------|------|-------------|
| `model` | string | LLM identifier (e.g., "anthropic/claude-haiku-4.5") |
| `system` | string | System prompt |
| `temperature` | number | Generation parameter (0-1) |
| `tools` | object | Tool definitions with execute functions |
| `toolChoice` | string | "auto" \| "required" \| "none" \| specific tool |
| `maxSteps` | number | Max LLM iterations |

## Callbacks

```typescript
const agent = new DurableAgent({
  model: "anthropic/claude-haiku-4.5",
  onFinish: (result) => console.log("Done:", result),
  onError: (error) => console.error("Error:", error),
  onAbort: () => console.log("Aborted"),
  onStepFinish: (step) => console.log("Step:", step),
});
```

## Streaming AI Responses

### In Workflow

```typescript
export async function streamingWorkflow(prompt: string) {
  "use workflow";
  globalThis.fetch = fetch;

  const writable = getWritable();
  await agent.stream({ messages: [{ role: "user", content: prompt }], writable });
}
```

### Reading Stream (Client)

```typescript
import { start } from "workflow/api";

const run = await start(streamingWorkflow, ["Hello"]);

for await (const chunk of run.readable) {
  console.log(chunk);
}
```

### Resumable Streams

```typescript
// Resume from specific position
const readable = run.getReadable({ startIndex: lastIndex });

for await (const chunk of readable) {
  process.stdout.write(chunk);
}
```

## WorkflowChatTransport

Transport layer for AI SDK with automatic reconnection:

```typescript
import { WorkflowChatTransport } from "@workflow/ai";

const transport = new WorkflowChatTransport({
  maxConsecutiveErrors: 3,
  onChatSendMessage: (response) => {
    // Extract workflow run ID from header
    const runId = response.headers.get("x-workflow-run-id");
  },
  onChatEnd: ({ chatId, chunkIndex }) => {
    console.log("Chat ended at chunk:", chunkIndex);
  },
});
```

## Piping AI SDK Responses

```typescript
async function generateWithAI(prompt: string) {
  "use step";

  const writable = getWritable();
  const response = await generateText({ prompt, stream: true });

  await response.pipeThrough(writable);
}
```

## Human-in-the-Loop AI

Combine AI with human approval:

```typescript
export async function contentApproval(topic: string) {
  "use workflow";
  globalThis.fetch = fetch;

  // AI generates draft
  const draft = await generateDraft(topic);

  // Wait for human review
  const hook = createHook<{ approved: boolean; feedback?: string }>();
  await notifyEditor(draft.id, hook.token);

  const review = await hook;

  if (review.approved) {
    await publish(draft);
    return { status: "published", draft };
  } else {
    // AI revises based on feedback
    const revised = await reviseDraft(draft, review.feedback);
    return { status: "revised", draft: revised };
  }
}

async function generateDraft(topic: string) {
  "use step";
  const writable = getWritable();
  return await agent.stream({
    messages: [{ role: "user", content: `Write about: ${topic}` }],
    writable,
  });
}
```

## Multi-Day AI Agents

Agents that operate over extended periods:

```typescript
export async function longRunningAgent(task: string) {
  "use workflow";
  globalThis.fetch = fetch;

  // Initial processing
  const plan = await createPlan(task);

  for (const step of plan.steps) {
    await executeStep(step);

    // Wait for external systems
    await sleep("1h");

    // Check status
    const status = await checkProgress(step);
    if (status.needsReview) {
      const hook = createHook<{ proceed: boolean }>();
      await notifyTeam(step, hook.token);
      const decision = await hook;
      if (!decision.proceed) break;
    }
  }

  return await generateReport(plan);
}
```

## Important Notes

1. **Always set globalThis.fetch** - AI SDK requires it
2. **Tools must use "use step"** - For durability and retry
3. **Use getWritable() in steps only** - Cannot stream from workflow function
4. **Release writer locks** - Call `writer.releaseLock()` after writing
