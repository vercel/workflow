/**
 * Minimal AI agent for exploring codebases
 *
 * This file contains only the agent logic - see shell.ts for the interactive loop.
 * Uses bash-tool with a just-bash OverlayFS to provide read access to the real project files.
 */

import * as path from 'node:path';
import { streamText, stepCountIs } from 'ai';
import { createBashTool } from 'bash-tool';
import { Bash, OverlayFs } from 'just-bash';

export interface AgentRunner {
  chat(
    message: string,
    callbacks: {
      onText: (text: string) => void;
    }
  ): Promise<void>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CreateAgentOptions {
  /** Directory to explore (defaults to just-bash project root) */
  rootDir?: string;
  onToolCall?: (command: string) => void;
  onToolResult?: (result: CommandResult) => void;
  onText?: (text: string) => void;
}

/**
 * Creates an agent runner that can explore a codebase
 */
export async function createAgent(
  options: CreateAgentOptions = {}
): Promise<AgentRunner> {
  const projectRoot = options.rootDir
    ? path.resolve(options.rootDir)
    : path.resolve(import.meta.dirname, '../..');

  // Create OverlayFS with the project root directory
  const overlayFs = new OverlayFs({
    root: projectRoot,
    mountPoint: '/workspace',
    readOnly: true,
  });

  // Create Bash instance with the OverlayFS
  const bash = new Bash({
    fs: overlayFs,
    cwd: '/workspace',
  });

  const toolkit = await createBashTool({
    sandbox: bash,
    destination: '/workspace',
    extraInstructions: `You have access to files and directories mounted at /workspace.
Use bash commands to explore:
- ls /workspace to see the directory structure
- cat /workspace/filename to read files
- grep -r "pattern" /workspace to search content
- find /workspace -name "*.ext" to find files by pattern
- head, tail, wc, sort, uniq for data analysis

Help the user explore, search, and understand the contents.`,
    onBeforeBashCall: (input) => {
      options.onToolCall?.(input.command);
      return undefined;
    },
    onAfterBashCall: (input) => {
      options.onToolResult?.(input.result);
      return undefined;
    },
  });

  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  return {
    async chat(message, callbacks) {
      history.push({ role: 'user', content: message });

      let fullText = '';

      const result = streamText({
        model: 'anthropic/claude-haiku-4.5',
        tools: { bash: toolkit.bash },
        stopWhen: stepCountIs(50),
        messages: history,
      });

      for await (const chunk of result.textStream) {
        options.onText?.(chunk);
        callbacks.onText(chunk);
        fullText += chunk;
      }

      history.push({ role: 'assistant', content: fullText });
    },
  };
}
