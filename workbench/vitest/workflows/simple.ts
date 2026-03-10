/**
 * Simple workflow example for testing the vitest plugin.
 * This file contains both "use workflow" and "use step" directives.
 */

export async function add(a: number, b: number): Promise<number> {
  'use step';
  return a + b;
}

export async function multiply(a: number, b: number): Promise<number> {
  'use step';
  return a * b;
}

export async function calculateWorkflow(x: number, y: number) {
  'use workflow';

  const sum = await add(x, y);
  const product = await multiply(x, y);

  return {
    sum,
    product,
    combined: sum + product,
  };
}
