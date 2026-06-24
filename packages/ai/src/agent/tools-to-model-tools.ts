import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3ProviderTool,
} from '@ai-sdk/provider';
import { asSchema, type ToolSet } from 'ai';
import {
  fatalSchemaDefinitionError,
  isZodSchemaDefinitionError,
} from './schema-error.js';

async function getSchemaDefinitionError(
  schema: ReturnType<typeof asSchema>
): Promise<unknown> {
  try {
    await schema.validate?.({});
  } catch (error) {
    if (isZodSchemaDefinitionError(error)) return error;
  }
}

async function getInputJsonSchema(name: string, tool: ToolSet[string]) {
  const schema = asSchema(tool.inputSchema);

  try {
    return await schema.jsonSchema;
  } catch (error) {
    const schemaDefinitionError = isZodSchemaDefinitionError(error)
      ? error
      : await getSchemaDefinitionError(schema);

    if (schemaDefinitionError) {
      throw fatalSchemaDefinitionError(
        schemaDefinitionError,
        `Invalid inputSchema for tool "${name}"`
      );
    }
    throw error;
  }
}

// Mirrors the tool→LanguageModelV3FunctionTool/LanguageModelV3ProviderTool
// mapping in the core AI SDK's prepareToolsAndToolChoice
// (ai/src/prompt/prepare-tools-and-tool-choice.ts).
export async function toolsToModelTools(
  tools: ToolSet
): Promise<Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>> {
  return Promise.all(
    Object.entries(tools).map(async ([name, tool]) => {
      const toolType = tool.type;

      switch (toolType) {
        case undefined:
        case 'dynamic':
        case 'function':
          return {
            type: 'function' as const,
            name,
            description: tool.description,
            inputSchema: await getInputJsonSchema(name, tool),
            ...(tool.inputExamples != null
              ? { inputExamples: tool.inputExamples }
              : {}),
            providerOptions: tool.providerOptions,
            ...(tool.strict != null ? { strict: tool.strict } : {}),
          };
        case 'provider':
          // Preserve provider tool identity (e.g. anthropic.tools.webSearch)
          // instead of converting to a plain function tool
          return {
            type: 'provider' as const,
            name,
            id: tool.id,
            args: tool.args ?? {},
          };
        default: {
          const exhaustiveCheck: never = toolType as never;
          throw new Error(`Unsupported tool type: ${exhaustiveCheck}`);
        }
      }
    })
  );
}
