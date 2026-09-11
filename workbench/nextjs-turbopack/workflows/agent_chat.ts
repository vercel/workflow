import { type ModelCallStreamPart, WorkflowAgent } from '@ai-sdk/workflow';
import { convertToModelMessages, tool, type UIMessage } from 'ai';
import { getWritable } from 'workflow';
import z from 'zod/v4';
import { DEFAULT_AI_MODEL } from '@/lib/ai-models';

// ============================================================================
// Tool step functions
// ============================================================================

async function getWeather(input: { city: string }): Promise<{
  city: string;
  temperature: number;
  unit: string;
  condition: string;
}> {
  'use step';
  // Fake weather data based on city name
  const hash = input.city
    .toLowerCase()
    .split('')
    .reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const temperature = 40 + (hash % 60); // 40-99°F
  const conditions = [
    'sunny',
    'cloudy',
    'rainy',
    'snowy',
    'windy',
    'partly cloudy',
  ];
  const condition = conditions[hash % conditions.length];
  return {
    city: input.city,
    temperature,
    unit: 'fahrenheit',
    condition,
  };
}

async function calculate(input: {
  expression: string;
}): Promise<{ expression: string; result: number }> {
  'use step';
  // Evaluate simple math expressions safely using Function constructor
  // Only allow numbers, operators, parentheses, and whitespace
  // Translate ^ to ** for exponentiation before sanitizing
  const translated = input.expression.replace(/\s/g, '').replace(/\^/g, '**');
  if (!/^[0-9+\-*/().]+$/.test(translated)) {
    throw new Error(`Invalid expression: ${input.expression}`);
  }
  // biome-ignore lint/security/noGlobalEval: sandboxed simple math evaluation
  const result = new Function(`return (${translated})`)() as number;
  return {
    expression: input.expression,
    result,
  };
}

// ============================================================================
// Chat workflow
// ============================================================================

export async function chat(messages: UIMessage[], model?: string) {
  'use workflow';

  const modelMessages = await convertToModelMessages(messages);

  const selectedModel = model || DEFAULT_AI_MODEL;

  // Enable reasoning for models that support it
  const isAnthropic = selectedModel.includes('anthropic/');
  const isOpenAI = selectedModel.includes('openai/');

  const providerOptions = {
    ...(isAnthropic
      ? { anthropic: { thinking: { type: 'enabled', budgetTokens: 10000 } } }
      : {}),
    ...(isOpenAI ? { openai: { reasoningEffort: 'medium' } } : {}),
  };

  const agent = new WorkflowAgent({
    model: selectedModel,
    providerOptions,
    instructions:
      'You are a helpful assistant with access to weather and calculator tools. Use them when the user asks about weather in a city or needs math calculations. Keep responses concise.',
    tools: {
      getWeather: tool({
        description:
          'Get the current weather for a city. Returns temperature in Fahrenheit and conditions.',
        inputSchema: z.object({
          city: z.string().describe('The city name to get weather for'),
        }),
        execute: getWeather,
      }),
      calculate: tool({
        description:
          'Evaluate a simple math expression. Supports +, -, *, /, and parentheses.',
        inputSchema: z.object({
          expression: z
            .string()
            .describe('The math expression to evaluate, e.g. "2 + 3 * 4"'),
        }),
        execute: calculate,
      }),
    },
    onStepEnd: async (stepResult) => {
      console.log('[agent_chat] onStepEnd:', {
        finishReason: stepResult.finishReason,
        text: stepResult.text?.slice(0, 100),
        toolCalls: stepResult.toolCalls?.length ?? 0,
        toolResults: stepResult.toolResults?.length ?? 0,
      });
    },
    onEnd: async (event) => {
      console.log('[agent_chat] onEnd:', {
        finishReason: event.finishReason,
        text: event.text?.slice(0, 100),
        totalSteps: event.steps.length,
        totalMessages: event.messages.length,
      });
    },
  });

  const result = await agent.stream({
    messages: modelMessages,
    writable: getWritable<ModelCallStreamPart>(),
  });

  return { messages: result.messages };
}
