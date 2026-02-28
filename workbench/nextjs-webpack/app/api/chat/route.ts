// THIS FILE IS JUST FOR TESTING HMR AS AN ENTRY NEEDS
// TO IMPORT THE WORKFLOWS TO DISCOVER THEM AND WATCH
import * as workflows from '@/workflows/3_streams';
// Test that steps inside dot-prefixed directories are discovered
import * as wellKnownAgentSteps from '@/app/.well-known/agent/v1/steps';

export async function POST(_req: Request) {
  console.log(workflows, wellKnownAgentSteps);
  return Response.json('hello world');
}
