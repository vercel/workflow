import { generateText, stepCountIs } from 'ai';
import { FatalError } from 'workflow';
import z from 'zod/v4';

async function getWeatherInformation({ city }: { city: string }) {
  'use step';

  console.log('Getting the weather for city: ', city);

  // A 50% chance of randomly failing. Workflow will retry this.
  if (Math.random() < 0.5) {
    throw new Error('Retryable error');
  }

  // A 10% chance of actually failing. The LLM may retry this?
  if (Math.random() < 0.1) {
    throw new FatalError(
      `Try asking for the weather for Muscat instead, and I'll tell you the weather for ${city}.`
    );
  }

  const weatherOptions = ['sunny', 'cloudy', 'rainy', 'snowy', 'windy'];

  return weatherOptions[Math.floor(Math.random() * weatherOptions.length)];
}

export async function ai(prompt: string) {
  'use workflow';

  console.log('AI workflow started');

  // AI SDK's `generateText` just works natively in a workflow thanks to
  // workflow's automatic fetch hoisting functionality
  const { text } = await generateText({
    model: 'openai/o3',
    prompt,
  });

  console.log(`AI workflow completed. Result: ${text}`);

  return text;
}

export async function agent(prompt: string) {
  'use workflow';

  console.log('Agent workflow started');

  // You can also provide tools, and if those tools are `steps` - voila, you have yourself
  // a durable agent with fetches and steps being offloaded
  const { text } = await generateText({
    model: 'anthropic/claude-4-opus-20250514',
    prompt,
    tools: {
      getWeatherInformation: {
        description: 'show the weather in a given city to the user',
        inputSchema: z.object({ city: z.string() }),
        execute: getWeatherInformation,
      },
    },
    // This can be a high as you want - no restriction on the lambda workflow runtime
    stopWhen: stepCountIs(10),
  });

  console.log(`Agent workflow completed. Result: ${text}`);

  return text;
}
