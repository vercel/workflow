import * as z from 'zod';
import { tool } from 'ai';

export const weatherTool = tool({
  description: 'Get the weather in a location',
  inputSchema: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  execute: async ({ location }) => {
    "use step";
    return {
      location,
      temperature: 72 + Math.floor(Math.random() * 21) - 10,
    };
  },
});

export const timeTool = tool({
  description: 'Get the current time',
  execute: async function timeToolImpl () {
    "use step";
    return {
      time: new Date().toISOString(),
    };
  },
});

export const weatherTool2 = tool({
  description: 'Get the weather in a location',
  inputSchema: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  async execute({ location }) {
    "use step";
    return {
      location,
      temperature: 72 + Math.floor(Math.random() * 21) - 10,
    };
  },
});
