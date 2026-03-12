/**
 * E2E test workflows for DurableAgent.
 *
 * These workflows use inline mock LanguageModelV2 implementations so they
 * don't require real LLM API keys. The mock models return deterministic
 * responses to validate DurableAgent behavior end-to-end through the
 * workflow runtime.
 */
import { DurableAgent } from '@workflow/ai/agent';
import { FatalError, getWritable } from 'workflow';
import z from 'zod/v4';

// ============================================================================
// Mock model helpers
// ============================================================================

// Use `any` for model types to avoid direct @ai-sdk/provider dependency.
// The runtime only cares about the shape, not the TypeScript type.

/**
 * Creates a ReadableStream from an array of stream parts.
 */
function streamFromParts(parts: any[]): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      try {
        for (const part of parts) {
          controller.enqueue(part);
        }
      } finally {
        controller.close();
      }
    },
  });
}

const finishPart = {
  type: 'finish',
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

/**
 * Creates a mock LanguageModelV2 that returns a text response.
 */
function createTextMockModel(text: string): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-text',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('not implemented');
    },
    doStream: async () => ({
      stream: streamFromParts([
        { type: 'stream-start', warnings: [] } as any,
        {
          type: 'response-metadata',
          id: 'resp-1',
          modelId: 'mock-text',
          timestamp: new Date(),
        } as any,
        { type: 'text-start', id: '1' } as any,
        { type: 'text-delta', id: '1', delta: text } as any,
        { type: 'text-end', id: '1' } as any,
        finishPart,
      ]),
    }),
  };
}

/**
 * Creates a mock LanguageModelV2 that calls a tool on first turn,
 * then returns text on second turn.
 */
function createToolCallMockModel(
  toolName: string,
  toolInput: string,
  finalText: string
): any {
  let callCount = 0;
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-tool',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('not implemented');
    },
    doStream: async () => {
      if (callCount++ === 0) {
        return {
          stream: streamFromParts([
            { type: 'stream-start', warnings: [] } as any,
            {
              type: 'response-metadata',
              id: 'resp-1',
              modelId: 'mock-tool',
              timestamp: new Date(),
            } as any,
            {
              type: 'tool-call',
              toolCallId: `call-${callCount}`,
              toolName,
              input: toolInput,
            } as any,
            toolCallFinishPart,
          ]),
        };
      }
      return {
        stream: streamFromParts([
          { type: 'stream-start', warnings: [] } as any,
          {
            type: 'response-metadata',
            id: `resp-${callCount + 1}`,
            modelId: 'mock-tool',
            timestamp: new Date(),
          } as any,
          { type: 'text-start', id: '1' } as any,
          { type: 'text-delta', id: '1', delta: finalText } as any,
          { type: 'text-end', id: '1' } as any,
          finishPart,
        ]),
      };
    },
  };
}

/**
 * Creates a mock model that calls a tool N times sequentially, then returns text.
 */
function createMultiStepMockModel(
  toolName: string,
  steps: number,
  finalText: string
): any {
  let callCount = 0;
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-multi',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('not implemented');
    },
    doStream: async () => {
      callCount++;
      if (callCount <= steps) {
        return {
          stream: streamFromParts([
            { type: 'stream-start', warnings: [] } as any,
            {
              type: 'response-metadata',
              id: `resp-${callCount}`,
              modelId: 'mock-multi',
              timestamp: new Date(),
            } as any,
            {
              type: 'tool-call',
              toolCallId: `call-${callCount}`,
              toolName,
              input: JSON.stringify({ step: callCount }),
            } as any,
            toolCallFinishPart,
          ]),
        };
      }
      return {
        stream: streamFromParts([
          { type: 'stream-start', warnings: [] } as any,
          {
            type: 'response-metadata',
            id: `resp-${callCount}`,
            modelId: 'mock-multi',
            timestamp: new Date(),
          } as any,
          { type: 'text-start', id: '1' } as any,
          { type: 'text-delta', id: '1', delta: finalText } as any,
          { type: 'text-end', id: '1' } as any,
          finishPart,
        ]),
      };
    },
  };
}

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
    model: async () => createTextMockModel(`Echo: ${prompt}`),
    system: 'You are a helpful assistant.',
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

  const agent = new DurableAgent({
    model: async () =>
      createToolCallMockModel(
        'addNumbers',
        JSON.stringify({ a, b }),
        `The sum is ${a + b}`
      ),
    tools: {
      addNumbers: {
        description: 'Add two numbers',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: addNumbers,
      },
    },
    system: 'You are a calculator assistant.',
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

  const agent = new DurableAgent({
    model: async () => createMultiStepMockModel('echoStep', 3, 'All done!'),
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

  // Model calls throwingTool, gets error result, then returns text
  const agent = new DurableAgent({
    model: async () =>
      createToolCallMockModel(
        'throwingTool',
        '{}',
        'Tool failed but I recovered.'
      ),
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
