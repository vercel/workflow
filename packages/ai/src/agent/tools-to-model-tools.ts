import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3ProviderTool,
} from '@ai-sdk/provider';
import { asSchema, type ToolSet } from 'ai';

export async function toolsToModelTools(
  tools: ToolSet
): Promise<Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>> {
  return Promise.all(
    Object.entries(tools).map(async ([name, tool]) => {
      // Preserve provider tool identity (e.g. anthropic.tools.webSearch)
      // instead of converting to a plain function tool
      if ((tool as any).type === 'provider') {
        return {
          type: 'provider' as const,
          id: (tool as any).id as `${string}.${string}`,
          name,
          args: (tool as any).args ?? {},
        };
      }

      return {
        type: 'function' as const,
        name,
        description: tool.description,
        inputSchema: await asSchema(tool.inputSchema).jsonSchema,
      };
    })
  );
}
