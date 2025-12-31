/**
 * These are the built-in steps that are "automatically available" in the workflow scope. They are
 * similar to "stdlib" except that are not meant to be imported by users, but are instead "just available"
 * alongside user defined steps. They are used internally by the runtime
 */
// Re-export stdlib for discovery - needed because lazy discovery doesn't pick it up via eager scanning.
// The workflow builder injects this as a builtin module available in the workflow runtime sandbox.
export * from '../stdlib.js';

export async function __builtin_response_array_buffer(res: Response) {
  'use step';
  return res.arrayBuffer();
}

export async function __builtin_response_json(res: Response) {
  'use step';
  return res.json();
}

export async function __builtin_response_text(res: Response) {
  'use step';
  return res.text();
}
