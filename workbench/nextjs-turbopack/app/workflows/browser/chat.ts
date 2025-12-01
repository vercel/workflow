/**
 * Browser workflow for LLM chat inference.
 *
 * This workflow runs entirely in the browser using WebLLM.
 * The LLM inference happens in a dedicated Web Worker for GPU acceleration.
 */

import { generateResponse } from '../../lib/webllm-service';

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type ChatInput = {
  messages: ChatMessage[];
};

export type ChatOutput = {
  content: string;
};

/**
 * Generate a chat response using the local LLM.
 *
 * @param input - The conversation messages
 * @returns The assistant's response
 */
export async function chatWithLLM(input: ChatInput): Promise<ChatOutput> {
  'use workflow';

  const response = await generateResponse(input.messages);

  return {
    content: response,
  };
}
