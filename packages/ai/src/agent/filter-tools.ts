import type { ToolSet } from 'ai';

/**
 * Filter a tool set to only include the specified active tools.
 */
export function filterToolSet(tools: ToolSet, activeTools: string[]): ToolSet {
  const filtered: ToolSet = {};
  for (const toolName of activeTools) {
    if (toolName in tools) {
      filtered[toolName] = tools[toolName];
    }
  }
  return filtered;
}
