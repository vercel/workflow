#!/usr/bin/env npx tsx
/**
 * Code Explorer Agent
 *
 * Usage: npx tsx main.ts [directory]
 *
 * Arguments:
 *   directory  Path to explore (defaults to just-bash project root)
 *
 * Requires ANTHROPIC_API_KEY environment variable.
 */

import { createAgent } from './agent.js';
import { runShell } from './shell.js';

const rootDir = process.argv[2];

let lastWasToolCall = false;

const agent = await createAgent({
  rootDir,
  onToolCall: (command) => {
    const prefix = lastWasToolCall ? '' : '\n';
    console.log(
      `${prefix}\x1b[34m\x1b[1mExecuting bash tool:\x1b[0m \x1b[36m${command.trim()}\x1b[0m`
    );
    lastWasToolCall = true;
  },
  onToolResult: (result) => {
    const output = result.stdout || result.stderr;
    if (output) {
      const lines = output.trim().split('\n');
      const preview = lines.slice(0, 5);
      const truncated =
        lines.length > 5 ? ` ... (${lines.length - 5} more lines)` : '';
      console.log(`\x1b[2m${preview.join('\n')}${truncated}\x1b[0m`);
    }
  },
  onText: () => {
    lastWasToolCall = false;
  },
});
runShell(agent, { rootDir });
