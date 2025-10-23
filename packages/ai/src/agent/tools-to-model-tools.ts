import type { LanguageModelV2FunctionTool } from '@ai-sdk/provider';
import { asSchema, type ToolSet } from 'ai';

export function toolsToModelTools(
  tools: ToolSet
): LanguageModelV2FunctionTool[] {
  return Object.entries(tools).map(([name, tool]) => ({
    type: 'function',
    name,
    description: tool.description,
    inputSchema: asSchema(tool.inputSchema).jsonSchema,
  }));
}
