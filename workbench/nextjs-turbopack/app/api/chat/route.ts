// Keep existing imports so HMR discovery still works
import * as wellKnownAgentSteps from '@/app/.well-known/agent/v1/steps';
import * as _workflows from '@/workflows/3_streams';
void wellKnownAgentSteps;
void _workflows;

import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { start } from 'workflow/api';
import { chat } from '@/workflows/agent_chat';

export async function POST(req: Request) {
  const { messages, model }: { messages: UIMessage[]; model?: string } =
    await req.json();
  const run = await start(chat, [messages, model]);

  const headers: Record<string, string> = {
    'x-workflow-run-id': run.runId,
  };

  // Only set Vercel observability headers when actually on Vercel
  if (process.env.VERCEL_ENV) {
    headers['x-workflow-team-slug'] =
      process.env.VERCEL_TEAM_SLUG ?? 'vercel-labs';
    headers['x-workflow-project-slug'] =
      process.env.VERCEL_PROJECT_SLUG ??
      process.env.VERCEL_PROJECT_NAME ??
      'example-nextjs-workflow-turbopack';
    headers['x-workflow-environment'] = process.env.VERCEL_ENV;
  }

  return createUIMessageStreamResponse({
    stream: run.readable,
    headers,
  });
}
