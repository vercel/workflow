/**
 * E2E test workflows for DurableAgent.
 *
 * Mock model factories are defined in THIS file (not imported from a package)
 * because the SWC plugin needs to see 'use step' directives in source files
 * it processes. Pre-compiled packages have their directives compiled away.
 */
import { DurableAgent } from '@workflow/ai/agent';
import { FatalError, getWritable } from 'workflow';
import z from 'zod/v4';

// ============================================================================
// Mock model step factories
// These MUST be in the workflow source file so the SWC plugin can extract them.
// ============================================================================

type MockResponse =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; input: string };

function streamFromArray<T>(values: T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const v of values) controller.enqueue(v);
      controller.close();
    },
  });
}

function makeTextStream(text: string) {
  return {
    stream: streamFromArray([
      { type: 'stream-start' as const, warnings: [] },
      {
        type: 'response-metadata' as const,
        id: 'r',
        modelId: 'mock',
        timestamp: new Date(),
      },
      { type: 'text-start' as const, id: '1' },
      { type: 'text-delta' as const, id: '1', delta: text },
      { type: 'text-end' as const, id: '1' },
      {
        type: 'finish' as const,
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 5, noCache: 5 },
          outputTokens: { total: 10, text: 10 },
        },
      },
    ]),
  };
}

function makeToolCallStream(toolName: string, input: string, callId: string) {
  return {
    stream: streamFromArray([
      { type: 'stream-start' as const, warnings: [] },
      {
        type: 'response-metadata' as const,
        id: 'r',
        modelId: 'mock',
        timestamp: new Date(),
      },
      { type: 'tool-call' as const, toolCallId: callId, toolName, input },
      {
        type: 'finish' as const,
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5 },
          outputTokens: { total: 10, text: 10 },
        },
      },
    ]),
  };
}

/**
 * Returns a model factory (with 'use step') that creates a mock text model.
 * Same pattern as `anthropic('claude-4-sonnet')` — returns async () => { 'use step'; ... }.
 * Only captures `text` (string) — fully serializable.
 */
function mockTextModelFactory(text: string) {
  return async () => {
    'use step';
    // Bind closure var to local so SWC detects it at step body level
    const _text = text;
    return {
      specificationVersion: 'v3' as const,
      provider: 'mock',
      modelId: 'mock-text',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('not implemented');
      },
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const v of [
              { type: 'stream-start', warnings: [] },
              {
                type: 'response-metadata',
                id: 'r',
                modelId: 'mock',
                timestamp: new Date(),
              },
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: _text },
              { type: 'text-end', id: '1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 5, noCache: 5 },
                  outputTokens: { total: 10, text: 10 },
                },
              },
            ])
              controller.enqueue(v);
            controller.close();
          },
        }),
      }),
    };
  };
}

/**
 * Returns a model factory (with 'use step') that creates a mock sequence model.
 * Same pattern as `anthropic('claude-4-sonnet')` — returns async () => { 'use step'; ... }.
 * Only captures `responses` (array of plain objects) — fully serializable.
 */
function mockSequenceModelFactory(responses: MockResponse[]) {
  return async () => {
    'use step';
    // Bind closure var to local so SWC detects it at step body level
    const _responses = responses;

    function _mkStream(parts: any[]) {
      return new ReadableStream({
        start(c) {
          for (const p of parts) c.enqueue(p);
          c.close();
        },
      });
    }

    return {
      specificationVersion: 'v3' as const,
      provider: 'mock',
      modelId: 'mock-sequence',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('not implemented');
      },
      doStream: async (options: any) => {
        const assistantCount = options.prompt.filter(
          (m: any) => m.role === 'assistant'
        ).length;
        const idx = Math.min(assistantCount, _responses.length - 1);
        const r = _responses[idx];
        if (r.type === 'text') {
          return {
            stream: _mkStream([
              { type: 'stream-start', warnings: [] },
              {
                type: 'response-metadata',
                id: 'r',
                modelId: 'mock',
                timestamp: new Date(),
              },
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: r.text },
              { type: 'text-end', id: '1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 5, noCache: 5 },
                  outputTokens: { total: 10, text: 10 },
                },
              },
            ]),
          };
        }
        return {
          stream: _mkStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'response-metadata',
              id: 'r',
              modelId: 'mock',
              timestamp: new Date(),
            },
            {
              type: 'tool-call',
              toolCallId: `call-${idx + 1}`,
              toolName: r.toolName,
              input: r.input,
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage: {
                inputTokens: { total: 5, noCache: 5 },
                outputTokens: { total: 10, text: 10 },
              },
            },
          ]),
        };
      },
    };
  };
}

// ============================================================================
// Tool step functions
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

export async function agentBasicE2e(prompt: string) {
  'use workflow';

  const agent = new DurableAgent({
    model: mockTextModelFactory(`Echo: ${prompt}`),
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

export async function agentToolCallE2e(a: number, b: number) {
  'use workflow';

  const agent = new DurableAgent({
    model: mockSequenceModelFactory([
      {
        type: 'tool-call',
        toolName: 'addNumbers',
        input: JSON.stringify({ a, b }),
      },
      { type: 'text', text: `The sum is ${a + b}` },
    ]),
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

export async function agentMultiStepE2e() {
  'use workflow';

  const agent = new DurableAgent({
    model: mockSequenceModelFactory([
      {
        type: 'tool-call',
        toolName: 'echoStep',
        input: JSON.stringify({ step: 1 }),
      },
      {
        type: 'tool-call',
        toolName: 'echoStep',
        input: JSON.stringify({ step: 2 }),
      },
      {
        type: 'tool-call',
        toolName: 'echoStep',
        input: JSON.stringify({ step: 3 }),
      },
      { type: 'text', text: 'All done!' },
    ]),
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

export async function agentErrorToolE2e() {
  'use workflow';

  const agent = new DurableAgent({
    model: mockSequenceModelFactory([
      { type: 'tool-call', toolName: 'throwingTool', input: '{}' },
      { type: 'text', text: 'Tool failed but I recovered.' },
    ]),
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
