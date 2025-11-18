import type {
  LanguageModelV2,
  LanguageModelV2Prompt,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from '@ai-sdk/provider';
import type { StepResult, ToolSet, UIMessageChunk } from 'ai';
import { doStreamStep, type ModelStopCondition } from './do-stream-step.js';
import { toolsToModelTools } from './tools-to-model-tools.js';

// This runs in the workflow context
export async function* streamTextIterator({
  prompt,
  tools = {},
  writable,
  model,
  stopConditions,
}: {
  prompt: LanguageModelV2Prompt;
  tools: ToolSet;
  writable: WritableStream<UIMessageChunk>;
  model: string | (() => Promise<LanguageModelV2>);
  stopConditions?: ModelStopCondition[] | ModelStopCondition;
}): AsyncGenerator<
  LanguageModelV2ToolCall[],
  void,
  LanguageModelV2ToolResultPart[]
> {
  const conversationPrompt = [...prompt]; // Create a mutable copy

  const steps: StepResult<any>[] = [];
  let done = false;
  while (!done) {
    const { toolCalls, finish, step } = await doStreamStep(
      conversationPrompt,
      model,
      writable,
      toolsToModelTools(tools)
    );
    steps.push(step);

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

      if (stopConditions) {
        const stopConditionList = Array.isArray(stopConditions)
          ? stopConditions
          : [stopConditions];
        if (stopConditionList.some((test) => test({ steps }))) {
          done = true;
        }
      }
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
