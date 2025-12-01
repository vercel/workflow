/**
 * Example browser workflow - simplified for testing.
 */

/**
 * Simple browser workflow that processes text.
 */
export async function browserExample(input: { text: string }) {
  'use workflow';

  // Simple processing - no steps for now
  const result = input.text.toUpperCase();

  return {
    input: input.text,
    processed: result,
    timestamp: Date.now(),
  };
}
