/**
 * These are the built-in steps that are "automatically available" in the workflow scope. They are
 * similar to "stdlib" except that are not meant to be imported by users, but are instead "just available"
 * alongside user defined steps. They are used internally by the runtime
 *
 * These helpers intentionally rely on the method receiver (`this`) so workflow
 * objects like `Request` and `Response` can round-trip through step execution.
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
