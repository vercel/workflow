import type { PrepareStepInfo, PrepareStepResult } from '@ai-sdk/workflow';

const queuedMessages: Array<{ role: 'user'; content: string }> = [];

// Keep the provider-prompt shape used by the message-queueing guide checked
// against the installed WorkflowAgent release.
export const prepareStep = ({
  messages,
}: PrepareStepInfo): PrepareStepResult => ({
  messages: [
    ...messages,
    ...queuedMessages.map(({ role, content }) => ({
      role,
      content: [{ type: 'text' as const, text: content }],
    })),
  ],
});
