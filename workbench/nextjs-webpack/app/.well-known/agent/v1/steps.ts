/**
 * Test file for verifying that workflow discovers step/workflow functions
 * inside dot-prefixed directories like `.well-known/agent/`.
 *
 * This simulates the pattern used by agent frameworks that place generated
 * step functions inside `app/.well-known/agent/v1/steps.ts`.
 */

export async function wellKnownAgentStep(input: number) {
  'use step';
  return input * 2;
}

export async function wellKnownAgentWorkflow(value: number) {
  'use workflow';
  const result = await wellKnownAgentStep(value);
  return result + 1;
}
