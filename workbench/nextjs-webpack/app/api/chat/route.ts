// THIS FILE IS JUST FOR TESTING HMR AS AN ENTRY NEEDS
// TO IMPORT THE WORKFLOWS TO DISCOVER THEM AND WATCH

// Test that steps inside dot-prefixed directories are discovered
import * as wellKnownAgentSteps from '@/app/.well-known/agent/v1/steps';
import * as workflows from '@/workflows/3_streams';

export async function POST(_req: Request) {
  console.log(workflows, wellKnownAgentSteps);
  return Response.json('hello world');
}
