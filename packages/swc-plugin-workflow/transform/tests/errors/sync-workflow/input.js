// Sync "use workflow" should still error (workflow functions must be async)
export function syncWorkflow() {
  'use workflow';
  return 'not allowed';
}

// Sync "use step" should NOT error (sync steps are allowed)
export function syncStep() {
  'use step';
  return 'allowed';
}
