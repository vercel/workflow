/**
 * E2E test workflows for DurableAgent using @workflow/ai/test mock providers.
 */
import { DurableAgent } from '@workflow/ai/agent';
import { mockTextModel, mockSequenceModel } from '@workflow/ai/test';
import { FatalError, getWritable } from 'workflow';
import z from 'zod/v4';

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
// Core agent tests
// ============================================================================

export async function agentBasicE2e(prompt: string) {
  'use workflow';
  const agent = new DurableAgent({
    model: mockTextModel(`Echo: ${prompt}`),
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
    model: mockSequenceModel([
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
    model: mockSequenceModel([
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
    model: mockSequenceModel([
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

// ============================================================================
// Provider tool tests — tool identity preserved across step boundaries
// ============================================================================

/**
 * Tests that provider tools (e.g. anthropic.tools.webSearch) are correctly
 * passed through to the model without being converted to function tools.
 * The mock model simulates a provider-executed tool call + result.
 */
export async function agentProviderToolE2e() {
  'use workflow';
  const agent = new DurableAgent({
    model: mockSequenceModel([
      {
        type: 'provider-tool-call',
        toolName: 'webSearch',
        input: JSON.stringify({ query: 'workflow sdk' }),
        result: { title: 'Workflow SDK', url: 'https://example.com' },
      },
      { type: 'text', text: 'I found a result for you.' },
    ]),
    tools: {
      webSearch: {
        type: 'provider',
        id: 'anthropic.web_search',
        args: { maxUses: 5 },
      } as any,
    },
  });
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'Search for workflow sdk' }],
    writable: getWritable(),
  });
  return {
    stepCount: result.steps.length,
    lastStepText: result.steps[result.steps.length - 1]?.text,
  };
}

/**
 * Tests mixing provider tools with regular function tools.
 * The mock model first calls a provider tool, then a regular tool.
 */
export async function agentMixedToolsE2e(a: number, b: number) {
  'use workflow';
  const agent = new DurableAgent({
    model: mockSequenceModel([
      {
        type: 'provider-tool-call',
        toolName: 'webSearch',
        input: JSON.stringify({ query: 'what is a + b' }),
        result: { answer: `${a} + ${b}` },
      },
      {
        type: 'tool-call',
        toolName: 'addNumbers',
        input: JSON.stringify({ a, b }),
      },
      { type: 'text', text: `The answer is ${a + b}` },
    ]),
    tools: {
      webSearch: {
        type: 'provider',
        id: 'anthropic.web_search',
        args: {},
      } as any,
      addNumbers: {
        description: 'Add two numbers',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: addNumbers,
      },
    },
  });
  const result = await agent.stream({
    messages: [{ role: 'user', content: `Search and add ${a} + ${b}` }],
    writable: getWritable(),
  });
  return {
    stepCount: result.steps.length,
    lastStepText: result.steps[result.steps.length - 1]?.text,
  };
}

// ============================================================================
// Callback tests — onStepFinish
// ============================================================================

export async function agentOnStepFinishE2e() {
  'use workflow';
  const callSources: string[] = [];
  let capturedStepResult: any = null;
  const agent = new DurableAgent({
    model: mockTextModel('hello'),
    onStepFinish: async () => {
      callSources.push('constructor');
    },
  });
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'test' }],
    writable: getWritable(),
    onStepFinish: async (stepResult) => {
      callSources.push('method');
      capturedStepResult = {
        text: stepResult.text,
        finishReason: stepResult.finishReason,
        stepNumber: (stepResult as any).stepNumber,
      };
    },
  });
  return { callSources, capturedStepResult, stepCount: result.steps.length };
}

// ============================================================================
// Callback tests — onFinish
// ============================================================================

export async function agentOnFinishE2e() {
  'use workflow';
  const callSources: string[] = [];
  let capturedEvent: any = null;
  const agent = new DurableAgent({
    model: mockTextModel('hello from finish'),
    onFinish: async () => {
      callSources.push('constructor');
    },
  });
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'test' }],
    writable: getWritable(),
    onFinish: async (event) => {
      callSources.push('method');
      capturedEvent = {
        text: (event as any).text,
        finishReason: (event as any).finishReason,
        stepsLength: event.steps.length,
        hasMessages: event.messages.length > 0,
        hasTotalUsage: (event as any).totalUsage != null,
      };
    },
  });
  return { callSources, capturedEvent, stepCount: result.steps.length };
}

// ============================================================================
// Instructions test
// ============================================================================

export async function agentInstructionsStringE2e() {
  'use workflow';
  const agent = new DurableAgent({
    model: mockTextModel('ok'),
    instructions: 'You are a pirate.',
  });
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'ahoy' }],
    writable: getWritable(),
  });
  return {
    stepCount: result.steps.length,
    lastStepText: result.steps[result.steps.length - 1]?.text,
  };
}

// ============================================================================
// Timeout test
// ============================================================================

export async function agentTimeoutE2e() {
  'use workflow';
  const agent = new DurableAgent({
    model: mockTextModel('fast response'),
  });
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'test' }],
    writable: getWritable(),
    timeout: 30000,
  });
  return {
    stepCount: result.steps.length,
    lastStepText: result.steps[result.steps.length - 1]?.text,
  };
}

// ============================================================================
// GAP tests — experimental_onStart
// ============================================================================

export async function agentOnStartE2e() {
  'use workflow';
  const callSources: string[] = [];
  const agent = new DurableAgent({
    model: mockTextModel('hello'),
    experimental_onStart: async () => {
      callSources.push('constructor');
    },
  } as any);
  await agent.stream({
    messages: [{ role: 'user', content: 'test' }],
    writable: getWritable(),
    experimental_onStart: async () => {
      callSources.push('method');
    },
  } as any);
  return { callSources };
}

// ============================================================================
// GAP tests — experimental_onStepStart
// ============================================================================

export async function agentOnStepStartE2e() {
  'use workflow';
  const callSources: string[] = [];
  const agent = new DurableAgent({
    model: mockTextModel('hello'),
    experimental_onStepStart: async () => {
      callSources.push('constructor');
    },
  } as any);
  await agent.stream({
    messages: [{ role: 'user', content: 'test' }],
    writable: getWritable(),
    experimental_onStepStart: async () => {
      callSources.push('method');
    },
  } as any);
  return { callSources };
}

// ============================================================================
// GAP tests — experimental_onToolCallStart
// ============================================================================

export async function agentOnToolCallStartE2e() {
  'use workflow';
  const calls: string[] = [];
  const agent = new DurableAgent({
    model: mockSequenceModel([
      {
        type: 'tool-call',
        toolName: 'echoStep',
        input: JSON.stringify({ step: 1 }),
      },
      { type: 'text', text: 'done' },
    ]),
    tools: {
      echoStep: {
        description: 'Echo',
        inputSchema: z.object({ step: z.number() }),
        execute: echoStep,
      },
    },
    experimental_onToolCallStart: async () => {
      calls.push('constructor');
    },
  } as any);
  await agent.stream({
    messages: [{ role: 'user', content: 'test' }],
    writable: getWritable(),
    experimental_onToolCallStart: async () => {
      calls.push('method');
    },
  } as any);
  return { calls };
}

// ============================================================================
// GAP tests — experimental_onToolCallFinish
// ============================================================================

export async function agentOnToolCallFinishE2e() {
  'use workflow';
  const calls: string[] = [];
  let capturedEvent: any = null;
  const agent = new DurableAgent({
    model: mockSequenceModel([
      {
        type: 'tool-call',
        toolName: 'addNumbers',
        input: JSON.stringify({ a: 1, b: 2 }),
      },
      { type: 'text', text: 'done' },
    ]),
    tools: {
      addNumbers: {
        description: 'Add two numbers',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: addNumbers,
      },
    },
    experimental_onToolCallFinish: async () => {
      calls.push('constructor');
    },
  } as any);
  await agent.stream({
    messages: [{ role: 'user', content: 'test' }],
    writable: getWritable(),
    experimental_onToolCallFinish: async (event: any) => {
      calls.push('method');
      capturedEvent = {
        toolName: event?.toolCall?.toolName,
        success: event?.success,
        output: event?.output,
      };
    },
  } as any);
  return { calls, capturedEvent };
}

// ============================================================================
// GAP tests — prepareCall
// ============================================================================

export async function agentPrepareCallE2e() {
  'use workflow';
  const agent = new DurableAgent({
    model: mockTextModel('ok'),
    prepareCall: ({ options, ...rest }: any) => ({
      ...rest,
      providerOptions: { test: { value: options?.value } },
    }),
  } as any);
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'test' }],
    writable: getWritable(),
  });
  return {
    stepCount: result.steps.length,
    lastStepText: result.steps[result.steps.length - 1]?.text,
  };
}

// ============================================================================
// GAP tests — tool approval (needsApproval)
// ============================================================================

/** Tool with needsApproval: true should pause the agent. */
export async function agentToolApprovalE2e() {
  'use workflow';
  const agent = new DurableAgent({
    model: mockSequenceModel([
      {
        type: 'tool-call',
        toolName: 'riskyTool',
        input: JSON.stringify({ action: 'delete' }),
      },
      { type: 'text', text: 'done' },
    ]),
    tools: {
      riskyTool: {
        description: 'A dangerous tool that needs approval',
        inputSchema: z.object({ action: z.string() }),
        execute: echoStep as any,
        needsApproval: true,
      } as any,
    },
  });
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'do something risky' }],
    writable: getWritable(),
  });
  return {
    // If approval works, toolCalls should have the pending call
    // but toolResults should be empty (tool wasn't executed yet)
    toolCallsCount: result.toolCalls.length,
    toolResultsCount: result.toolResults.length,
    stepCount: result.steps.length,
    firstToolCallName: result.toolCalls[0]?.toolName,
  };
}

// ============================================================================
// prepareStep on constructor
// ============================================================================

async function prepareStepStep(input: { n: number }): Promise<string> {
  'use step';
  return `prepared-${input.n}`;
}

/** Agent-level prepareStep should be used when stream does not provide one. */
export async function agentConstructorPrepareStepE2e() {
  'use workflow';
  const stepNumbers: number[] = [];

  const agent = new DurableAgent({
    model: mockSequenceModel([
      { type: 'tool-call', toolName: 'greet', input: JSON.stringify({ n: 1 }) },
      { type: 'text', text: 'done' },
    ]),
    tools: {
      greet: {
        description: 'Greet',
        inputSchema: z.object({ n: z.number() }),
        execute: prepareStepStep,
      },
    },
    prepareStep: ({ stepNumber }) => {
      stepNumbers.push(stepNumber);
      return {};
    },
  });

  const result = await agent.stream({
    messages: [{ role: 'user', content: 'go' }],
    writable: getWritable(),
  });

  return {
    stepCount: result.steps.length,
    // prepareStep should have been called for each LLM step
    prepareStepCallCount: stepNumbers.length,
    prepareStepNumbers: stepNumbers,
  };
}

/** Stream-level prepareStep should override constructor-level. */
export async function agentStreamPrepareStepOverrideE2e() {
  'use workflow';
  const source: string[] = [];

  const agent = new DurableAgent({
    model: mockTextModel('ok'),
    prepareStep: () => {
      source.push('constructor');
      return {};
    },
  });

  await agent.stream({
    messages: [{ role: 'user', content: 'go' }],
    writable: getWritable(),
    prepareStep: () => {
      source.push('stream');
      return {};
    },
  });

  return {
    // Only 'stream' should appear — constructor-level is overridden
    source,
  };
}

// ============================================================================
// Multimodal tool results (#848)
// ============================================================================

async function multimodalToolStep(): Promise<{
  type: 'content';
  value: Array<{
    type: string;
    text?: string;
    data?: string;
    mediaType?: string;
  }>;
}> {
  'use step';
  return {
    type: 'content',
    value: [
      { type: 'text', text: 'Here is the image' },
      { type: 'file-data', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
    ],
  };
}

/** Tools returning LanguageModelV3ToolResultOutput should pass through. */
export async function agentMultimodalToolResultE2e() {
  'use workflow';
  const agent = new DurableAgent({
    model: mockSequenceModel([
      { type: 'tool-call', toolName: 'vision', input: '{}' },
      { type: 'text', text: 'I see the image' },
    ]),
    tools: {
      vision: {
        description: 'Returns multimodal content',
        inputSchema: z.object({}),
        execute: multimodalToolStep,
      },
    },
  });

  const result = await agent.stream({
    messages: [{ role: 'user', content: 'show me' }],
    writable: getWritable(),
  });

  return {
    stepCount: result.steps.length,
    lastStepText: result.steps[result.steps.length - 1]?.text,
    toolResults: result.toolResults,
  };
}
