// Shared helper functions that can be imported by workflows

export function throwError() {
  throw new Error('Error from imported helper module');
}

export function callThrower() {
  throwError();
}
