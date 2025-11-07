import type {
  LanguageModelV2Prompt,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from '@ai-sdk/provider';
import type { LanguageModel, ToolSet, UIMessageChunk } from 'ai';
import { doStreamStep } from './do-stream-step.js';
import { toolsToModelTools } from './tools-to-model-tools.js';

// This runs in the workflow context
export async function* streamTextIterator({
  prompt,
  tools = {},
  writable,
  model,
}: {
  prompt: LanguageModelV2Prompt;
  tools: ToolSet;
  writable: WritableStream<UIMessageChunk>;
  model: LanguageModel;
}): AsyncGenerator<
  LanguageModelV2ToolCall[],
  void,
  LanguageModelV2ToolResultPart[]
> {
  const conversationPrompt = [...prompt]; // Create a mutable copy

  let done = false;
  while (!done) {
    const { toolCalls, finish } = await doStreamStep(
      conversationPrompt,
      model,
      writable,
      toolsToModelTools(tools)
    );

    if (finish?.finishReason === 'tool-calls') {
      // Add assistant message with tool calls to the conversation
      conversationPrompt.push({
        role: 'assistant',
        content: toolCalls.map((toolCall) => ({
          type: 'tool-call',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: JSON.parse(toolCall.input),
        })),
      });

      // Yield the tool calls and wait for results
      const toolResults = yield toolCalls;

      await writeToolOutputToUI(writable, toolResults);

      conversationPrompt.push({
        role: 'tool',
        content: toolResults,
      });
    } else if (finish?.finishReason === 'stop') {
      done = true;
    } else {
      throw new Error(`Unexpected finish reason: ${finish?.finishReason}`);
    }
  }
}

async function writeToolOutputToUI(
  writable: WritableStream<UIMessageChunk>,
  toolResults: LanguageModelV2ToolResultPart[]
) {
  'use step';

  // need to write to the ui message stream here
  const writer = writable.getWriter();
  try {
    for (const result of toolResults) {
      await writer.write({
        type: 'tool-output-available',
        toolCallId: result.toolCallId,
        output: JSON.stringify(result) ?? '',
      });
    }
  } finally {
    writer.releaseLock();
  }
}
