/**
 * Shared helpers for the direct-step server action repro.
 * These imports must stay alive in client-mode transformed output.
 */
export const incrementValue = (value: number): number => value + 1;

/**
 * Keep formatting separate so the step exercises multiple helper imports.
 */
export const formatStepResult = (value: number): string =>
  `step-result:${value}`;
