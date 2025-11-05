import { tool } from 'ai';
import { z } from 'zod';

export const weatherTool = tool({
  description: 'Get the weather in a location',
  parameters: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  execute: async ({ location }) => {
    'use step';
    const response = await fetch(
      `https://api.weather.com/v1/current?location=${location}`
    );
    return response.json();
  },
});
