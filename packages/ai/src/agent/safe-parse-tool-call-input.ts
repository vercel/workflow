/**
 * Parse streamed tool-call input without crashing the workflow step when a
 * provider emits malformed or truncated JSON.
 */
export function safeParseToolCallInput(input: string | undefined): unknown {
  if (input == null || input === '') {
    return {};
  }

  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
