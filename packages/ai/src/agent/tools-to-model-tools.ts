import type { LanguageModelV3FunctionTool } from '@ai-sdk/provider';
import { asSchema, type ToolSet } from 'ai';

// Mirrors the tool→LanguageModelV3FunctionTool mapping in the core AI SDK's
// prepareToolsAndToolChoice (ai/src/prompt/prepare-tools-and-tool-choice.ts).
export async function toolsToModelTools(
  tools: ToolSet
): Promise<LanguageModelV3FunctionTool[]> {
  return Promise.all(
    Object.entries(tools).map(async ([name, tool]) => ({
      type: 'function' as const,
      name,
      description: tool.description,
      inputSchema: await asSchema(tool.inputSchema).jsonSchema,
      ...(tool.inputExamples != null
        ? { inputExamples: tool.inputExamples }
        : {}),
      providerOptions: tool.providerOptions,
      ...(tool.strict != null ? { strict: tool.strict } : {}),
    }))
  );
}
