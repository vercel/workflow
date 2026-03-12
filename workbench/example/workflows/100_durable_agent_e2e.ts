/**
 * E2E test workflows for DurableAgent.
 *
 * These workflows use MockLanguageModelV3 from ai/test (wrapped via
 * @workflow/ai/test) so they don't require real LLM API keys. The mock
 * models return deterministic responses to validate DurableAgent behavior
 * end-to-end through the workflow runtime.
 */
import { DurableAgent } from '@workflow/ai/agent';
import { mockModel, convertArrayToReadableStream } from '@workflow/ai/test';
import { FatalError, getWritable } from 'workflow';
import z from 'zod/v4';

// ============================================================================
// Shared stream parts
// ============================================================================

const finishPart = {
  type: 'finish' as const,
  finishReason: { unified: 'stop', raw: 'stop' } as any,
  usage: {
    inputTokens: { total: 5, noCache: 5 } as any,
    outputTokens: { total: 10, text: 10 } as any,
  },
};

const toolCallFinishPart = {
  ...finishPart,
  finishReason: { unified: 'tool-calls', raw: undefined } as any,
};

// ============================================================================
// Step functions
// ============================================================================

async function addNumbers(input: { a: number; b: number }): Promise<number> {
  'use step';
  return input.a + input.b;
}

async function echoStep(input: { step: number }): Promise<string> {
  'use step';
  return `step-${input.step}-done`;
}

async function throwingStep(): Promise<string> {
  'use step';
  throw new FatalError('Tool execution failed fatally');
}

// ============================================================================
// E2E Workflow functions
// ============================================================================

/**
 * Basic agent: mock model returns text immediately, no tools.
 */
export async function agentBasicE2e(prompt: string) {
  'use workflow';

  const agent = new DurableAgent({
    model: mockModel({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          {
            type: 'response-metadata' as const,
            id: 'resp-1',
            modelId: 'mock-text',
            timestamp: new Date(),
          },
          { type: 'text-start' as const, id: '1' },
          {
            type: 'text-delta' as const,
            id: '1',
            delta: `Echo: ${prompt}`,
          },
          { type: 'text-end' as const, id: '1' },
          finishPart,
        ]),
      }),
    }),
    instructions: 'You are a helpful assistant.',
  });

  const result = await agent.stream({
    messages: [{ role: 'user', content: prompt }],
    writable: getWritable(),
  });

  return {
    stepCount: result.steps.length,
    lastStepText: result.steps[result.steps.length - 1]?.text,
  };
}

/**
 * Single tool call: mock model calls addNumbers tool, then returns text.
 */
export async function agentToolCallE2e(a: number, b: number) {
  'use workflow';

  let callCount = 0;
  const agent = new DurableAgent({
    model: mockModel({
      doStream: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start' as const, warnings: [] },
              {
                type: 'response-metadata' as const,
                id: 'resp-1',
                modelId: 'mock-tool',
                timestamp: new Date(),
              },
              {
                type: 'tool-call' as const,
                toolCallId: `call-${callCount}`,
                toolName: 'addNumbers',
                input: JSON.stringify({ a, b }),
              },
              toolCallFinishPart,
            ]),
          };
        }
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start' as const, warnings: [] },
            {
              type: 'response-metadata' as const,
              id: `resp-${callCount}`,
              modelId: 'mock-tool',
              timestamp: new Date(),
            },
            { type: 'text-start' as const, id: '1' },
            {
              type: 'text-delta' as const,
              id: '1',
              delta: `The sum is ${a + b}`,
            },
            { type: 'text-end' as const, id: '1' },
            finishPart,
          ]),
        };
      },
    }),
    tools: {
      addNumbers: {
        description: 'Add two numbers',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: addNumbers,
      },
    },
    instructions: 'You are a calculator assistant.',
  });

  const result = await agent.stream({
    messages: [{ role: 'user', content: `Add ${a} and ${b}` }],
    writable: getWritable(),
  });

  return {
    stepCount: result.steps.length,
    toolResults: result.toolResults,
    lastStepText: result.steps[result.steps.length - 1]?.text,
  };
}

/**
 * Multi-step tool calling: mock model calls echoStep 3 times sequentially.
 */
export async function agentMultiStepE2e() {
  'use workflow';

  let callCount = 0;
  const totalToolSteps = 3;
  const agent = new DurableAgent({
    model: mockModel({
      doStream: async () => {
        callCount++;
        if (callCount <= totalToolSteps) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start' as const, warnings: [] },
              {
                type: 'response-metadata' as const,
                id: `resp-${callCount}`,
                modelId: 'mock-multi',
                timestamp: new Date(),
              },
              {
                type: 'tool-call' as const,
                toolCallId: `call-${callCount}`,
                toolName: 'echoStep',
                input: JSON.stringify({ step: callCount }),
              },
              toolCallFinishPart,
            ]),
          };
        }
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start' as const, warnings: [] },
            {
              type: 'response-metadata' as const,
              id: `resp-${callCount}`,
              modelId: 'mock-multi',
              timestamp: new Date(),
            },
            { type: 'text-start' as const, id: '1' },
            { type: 'text-delta' as const, id: '1', delta: 'All done!' },
            { type: 'text-end' as const, id: '1' },
            finishPart,
          ]),
        };
      },
    }),
    tools: {
      echoStep: {
        description: 'Echo the step number',
        inputSchema: z.object({ step: z.number() }),
        execute: echoStep,
      },
    },
  });

  const result = await agent.stream({
    messages: [{ role: 'user', content: 'Run 3 steps' }],
    writable: getWritable(),
  });

  return {
    stepCount: result.steps.length,
    lastStepText: result.steps[result.steps.length - 1]?.text,
  };
}

/**
 * Error tool: mock model calls a tool that throws FatalError.
 * The agent should convert this to a tool error result and continue.
 */
export async function agentErrorToolE2e() {
  'use workflow';

  let callCount = 0;
  const agent = new DurableAgent({
    model: mockModel({
      doStream: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start' as const, warnings: [] },
              {
                type: 'response-metadata' as const,
                id: 'resp-1',
                modelId: 'mock-error',
                timestamp: new Date(),
              },
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'throwingTool',
                input: '{}',
              },
              toolCallFinishPart,
            ]),
          };
        }
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start' as const, warnings: [] },
            {
              type: 'response-metadata' as const,
              id: `resp-${callCount}`,
              modelId: 'mock-error',
              timestamp: new Date(),
            },
            { type: 'text-start' as const, id: '1' },
            {
              type: 'text-delta' as const,
              id: '1',
              delta: 'Tool failed but I recovered.',
            },
            { type: 'text-end' as const, id: '1' },
            finishPart,
          ]),
        };
      },
    }),
    tools: {
      throwingTool: {
        description: 'A tool that always fails',
        inputSchema: z.object({}),
        execute: throwingStep,
      },
    },
  });

  const result = await agent.stream({
    messages: [{ role: 'user', content: 'Call the throwing tool' }],
    writable: getWritable(),
  });

  return {
    stepCount: result.steps.length,
    lastStepText: result.steps[result.steps.length - 1]?.text,
  };
}
