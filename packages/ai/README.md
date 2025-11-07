# @workflow/ai

[Workflow DevKit](https://useworkflow.dev) compatible helper library for the [AI SDK](https://ai-sdk.dev/).

## Features

### DurableAgent

Build durable AI agents within workflows that can:
- Maintain state across workflow steps
- Call tools implemented as workflow steps for automatic retries and persistence
- Gracefully handle interruptions and resumptions
- Control execution with `stopWhen` conditions

### stopWhen Support

The `DurableAgent` class supports the `stopWhen` property, making it compatible with AI SDK 6's ToolLoopAgent interface for easy portability. You can configure stop conditions either in the constructor or when calling the `stream` method.

#### Example

```typescript
import { DurableAgent } from '@workflow/ai/agent';
import { stepCountIs, hasToolCall } from '@workflow/ai';
import z from 'zod';

// Define your tools
const tools = {
  getWeather: {
    description: 'Get weather for a location',
    inputSchema: z.object({ location: z.string() }),
    execute: async ({ location }) => {
      'use step';
      // Your tool implementation
      return { temperature: 72, condition: 'sunny' };
    },
  },
};

// Create an agent with stopWhen in the constructor
const agent = new DurableAgent({
  model: 'anthropic/claude-opus',
  tools,
  system: 'You are a helpful weather assistant.',
  stopWhen: stepCountIs(10), // Stop after 10 steps
});

// Or override stopWhen when streaming
await agent.stream({
  messages: [{ role: 'user', content: 'What is the weather?' }],
  stopWhen: [
    stepCountIs(5),           // Stop after 5 steps, OR
    hasToolCall('getWeather') // Stop when getWeather tool is called
  ],
});
```

## Exported Types and Functions

For convenience, the following types and functions from the AI SDK are re-exported:

- `StepResult` - Type representing the result of a single step
- `StopCondition` - Type for stop condition functions
- `stepCountIs(count)` - Helper to stop after a specific number of steps
- `hasToolCall(toolName)` - Helper to stop when a specific tool is called

## Compatibility

The `DurableAgent` class is designed to be similar in interface to AI SDK 6's ToolLoopAgent for easy portability between the two.

