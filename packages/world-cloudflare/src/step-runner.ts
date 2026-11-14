/**
 * Executes one queued step outside the run's Durable Object.
 *
 * The run object calls this entrypoint (a separate invocation of the same
 * Worker) for every step message. Core's queued-step path runs the step body
 * and writes `step_started`/`step_completed` through the World, which here is
 * an RPC back to the run object. Because the World declares
 * `capabilities.invoke`, core then hands the replay back to the run object
 * with a wake instead of replaying in this invocation.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { serve } from './rpc.js';
import { type DeliveryMeta, deliver } from './runtime.js';

export class StepRunner extends WorkerEntrypoint {
  async run(message: unknown, meta: DeliveryMeta) {
    return serve(() => deliver(message, meta));
  }
}
