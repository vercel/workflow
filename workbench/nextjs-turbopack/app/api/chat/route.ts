// Keep existing imports so HMR discovery still works
import * as wellKnownAgentSteps from '@/app/.well-known/agent/v1/steps';
import * as _workflows from '@/workflows/3_streams';
void wellKnownAgentSteps;
void _workflows;

import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { start } from 'workflow/api';
import { chat } from '@/workflows/agent_chat';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const run = await start(chat, [messages]);

  return createUIMessageStreamResponse({
    stream: run.readable,
    headers: {
      'x-workflow-run-id': run.runId,
    },
  });
}
