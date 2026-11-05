/**
 * RPC plumbing between the World client and the Durable Objects.
 *
 * Errors do not cross Workers RPC with their class intact, and the runtime
 * matches World errors by class (`EntityConflictError.is(err)` and friends),
 * so every object method returns an `InvocationOutcome` and the client
 * restores the error on its side.
 */

import type {
  DurableObjectNamespace,
  DurableObjectStub,
} from 'cloudflare:workers';
import { env } from 'cloudflare:workers';
import { WorkflowWorldError } from '@workflow/errors';
import {
  captureInvocationOutcome,
  unwrapInvocationOutcome,
} from '@workflow/errors/invocation';
import type { InvocationOutcome } from '@workflow/world';

export const RUNS_BINDING = 'WORKFLOW_RUNS';
export const TOKENS_BINDING = 'WORKFLOW_TOKENS';
export const STREAMS_BINDING = 'WORKFLOW_STREAMS';

export function namespace(binding: string): DurableObjectNamespace {
  const ns = env[binding] as DurableObjectNamespace | undefined;
  if (!ns) {
    throw new WorkflowWorldError(
      `world-cloudflare: missing Durable Object binding "${binding}"`,
      { status: 500 }
    );
  }
  return ns;
}

/** A fresh stub per call: a stub can be left broken by a failed call. */
export function stub(binding: string, name: string): DurableObjectStub {
  return namespace(binding).getByName(name);
}

/** Server side: run a method body and return its outcome. */
export function serve<T>(fn: () => Promise<T> | T): Promise<InvocationOutcome> {
  return captureInvocationOutcome(async () => fn());
}

/** Client side: call an object method and restore its value or error. */
export async function call<T>(
  binding: string,
  name: string,
  method: string,
  ...args: unknown[]
): Promise<T> {
  const outcome = await stub(binding, name)[method](...args);
  return unwrapInvocationOutcome(outcome) as T;
}
