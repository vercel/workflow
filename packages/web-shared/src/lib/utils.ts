import type { ModelMessage } from 'ai';

// ============================================================================
// Durable Agent Utilities
// ============================================================================

/**
 * Check if a step is a doStreamStep (LLM call with conversation input)
 */
export function isDoStreamStep(stepName: string): boolean {
  return stepName.endsWith('//doStreamStep');
}

/**
 * Extract the conversation from a hydrated doStreamStep input.
 * doStreamStep signature: (conversationPrompt, model, writable, tools, options)
 * So input[0] is the conversation.
 */
export function extractConversation(stepInput: unknown): ModelMessage[] | null {
  if (!Array.isArray(stepInput) || stepInput.length === 0) {
    return null;
  }

  const firstArg = stepInput[0];

  if (!Array.isArray(firstArg)) {
    return null;
  }

  // Validate it looks like ModelMessage[]
  if (
    !firstArg.every((msg) => msg && typeof msg === 'object' && 'role' in msg)
  ) {
    return null;
  }

  return firstArg as ModelMessage[];
}
