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
// E2E Workflow functions
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
      { type: 'tool-call', toolName: 'addNumbers', input: JSON.stringify({ a, b }) },
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
      { type: 'tool-call', toolName: 'echoStep', input: JSON.stringify({ step: 1 }) },
      { type: 'tool-call', toolName: 'echoStep', input: JSON.stringify({ step: 2 }) },
      { type: 'tool-call', toolName: 'echoStep', input: JSON.stringify({ step: 3 }) },
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
