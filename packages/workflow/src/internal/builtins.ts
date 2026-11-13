/**
 * Built-in steps available in the workflow scope. Like a standard library,
 * they are available alongside user-defined steps, but users do not import
 * them. The runtime uses these steps internally.
 */

export async function __builtin_response_array_buffer(
  this: Request | Response
) {
  'use step';
  return this.arrayBuffer();
}

export async function __builtin_response_json(this: Request | Response) {
  'use step';
  return this.json();
}

export async function __builtin_response_text(this: Request | Response) {
  'use step';
  return this.text();
}
