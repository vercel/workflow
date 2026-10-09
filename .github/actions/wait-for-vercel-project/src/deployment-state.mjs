const TERMINAL_FAILURE_STATES = new Set(['ERROR', 'CANCELED']);

export function getTerminalDeploymentState(deployment) {
  if (
    deployment.state &&
    TERMINAL_FAILURE_STATES.has(deployment.state.toUpperCase())
  ) {
    return deployment.state;
  }

  if (
    deployment.readyState &&
    TERMINAL_FAILURE_STATES.has(deployment.readyState.toUpperCase())
  ) {
    return deployment.readyState;
  }

  return undefined;
}
