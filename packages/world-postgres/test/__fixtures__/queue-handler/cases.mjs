// The cases of the queue handler parity fixture, and the driver that runs
// them. Shared by `record.mjs` (which recorded `expected.json` from
// `@workflow/world-local`'s handler, the one the Postgres World used until it
// got its own) and `queue-handler-parity.test.ts` (which replays them against
// the Postgres World's handler). Plain JavaScript so both can import it.

export const PREFIX = '__wkf_workflow_';
export const CREATED_AT = '2026-11-01T12:00:00.000Z';

const fullHeaders = (overrides = {}) => ({
  'content-type': 'application/json',
  'x-vqs-queue-name': `${PREFIX}parity`,
  'x-vqs-message-id': 'msg_01PARITY00000000000000000A',
  'x-vqs-message-attempt': '2',
  'x-vqs-message-delivery-count': '5',
  'x-vqs-message-created-at': CREATED_AT,
  ...overrides,
});

function without(headers, ...names) {
  const copy = { ...headers };
  for (const name of names) delete copy[name];
  return copy;
}

/** The wire encoding of a body: JSON with the `Uint8Array` envelope. */
export function encodeBody(value) {
  return JSON.stringify(value, (_key, v) =>
    v instanceof Uint8Array
      ? { __type: 'Uint8Array', data: Buffer.from(v).toString('base64') }
      : v
  );
}

/**
 * One request each. `handler` says what the runtime's handler does with the
 * message: return a value, or throw.
 */
export const REQUEST_CASES = [
  {
    name: 'an orchestrator delivery (spec 8)',
    headers: fullHeaders(),
    body: { runId: 'wrun_parity_a' },
    handler: { returns: undefined },
  },
  {
    name: 'a delivery without a delivery count or a creation time',
    headers: without(
      fullHeaders(),
      'x-vqs-message-delivery-count',
      'x-vqs-message-created-at'
    ),
    body: { runId: 'wrun_parity_b', runSpecVersion: 9 },
    handler: { returns: undefined },
  },
  {
    name: 'a step message whose body carries a Uint8Array',
    headers: fullHeaders(),
    body: {
      runId: 'wrun_parity_c',
      stepId: 'step_parity_c',
      stepName: 'parityStep',
      input: new Uint8Array([1, 2, 3, 250]),
    },
    handler: { returns: undefined },
  },
  {
    name: 'a health check message',
    headers: fullHeaders(),
    body: { __healthCheck: true, correlationId: 'parity-probe' },
    handler: { returns: undefined },
  },
  {
    name: 'an invoke message, whose result is the response',
    headers: fullHeaders(),
    body: { runId: 'wrun_parity_d', invoke: true, requestId: 'req_parity' },
    handler: { returns: { answer: 42, nested: { ok: true } } },
  },
  {
    name: 'a handler that asks for a redelivery',
    headers: fullHeaders(),
    body: { runId: 'wrun_parity_e' },
    handler: { returns: { timeoutSeconds: 30 } },
  },
  {
    name: 'a handler that hands off (timeoutSeconds 0)',
    headers: fullHeaders(),
    body: { runId: 'wrun_parity_f', runSpecVersion: 9 },
    handler: { returns: { timeoutSeconds: 0 } },
  },
  {
    name: 'a handler whose timeoutSeconds is not a number',
    headers: fullHeaders(),
    body: { runId: 'wrun_parity_g' },
    handler: { returns: { timeoutSeconds: 'soon' } },
  },
  {
    name: 'a handler that returns an unrelated object',
    headers: fullHeaders(),
    body: { runId: 'wrun_parity_h' },
    handler: { returns: { done: true } },
  },
  {
    name: 'a handler that throws',
    headers: fullHeaders(),
    body: { runId: 'wrun_parity_i' },
    handler: { throws: 'parity failure' },
  },
  {
    name: 'a request without delivery headers',
    headers: { 'content-type': 'application/json' },
    body: { runId: 'wrun_parity_j' },
    handler: { returns: undefined },
  },
  {
    name: 'a request whose attempt is not a number',
    headers: fullHeaders({ 'x-vqs-message-attempt': 'two' }),
    body: { runId: 'wrun_parity_k' },
    handler: { returns: undefined },
  },
  {
    name: 'a request whose delivery count is zero',
    headers: fullHeaders({ 'x-vqs-message-delivery-count': '0' }),
    body: { runId: 'wrun_parity_l' },
    handler: { returns: undefined },
  },
  {
    name: 'a request whose creation time is not a date',
    headers: fullHeaders({ 'x-vqs-message-created-at': 'yesterday' }),
    body: { runId: 'wrun_parity_m' },
    handler: { returns: undefined },
  },
  {
    name: "a request for another prefix's queue",
    headers: fullHeaders({ 'x-vqs-queue-name': '__other_wkf_workflow_parity' }),
    body: { runId: 'wrun_parity_n' },
    handler: { returns: undefined },
  },
  {
    name: 'a request without a body',
    headers: fullHeaders(),
    body: null,
    handler: { returns: undefined },
  },
  {
    name: 'a request without a body or delivery headers',
    headers: {},
    body: null,
    handler: { returns: undefined },
  },
];

/**
 * Two deliveries fired at once, each held by the driver until released. The
 * recorded event order says whether the handler serialized them.
 */
export const CONCURRENCY_CASES = [
  {
    name: 'two orchestrator deliveries of one single-orchestrator run',
    messages: [
      { runId: 'wrun_gate_a', runSpecVersion: 9 },
      { runId: 'wrun_gate_a', runSpecVersion: 9 },
    ],
  },
  {
    name: 'two deliveries of one spec 8 run',
    messages: [{ runId: 'wrun_gate_b' }, { runId: 'wrun_gate_b' }],
  },
  {
    name: 'an orchestrator delivery and a step message of one single-orchestrator run',
    messages: [
      { runId: 'wrun_gate_c', runSpecVersion: 9 },
      {
        runId: 'wrun_gate_c',
        runSpecVersion: 9,
        stepId: 'step_gate_c',
        stepName: 'gateStep',
      },
    ],
  },
  {
    name: 'orchestrator deliveries of two single-orchestrator runs',
    messages: [
      { runId: 'wrun_gate_d', runSpecVersion: 9 },
      { runId: 'wrun_gate_e', runSpecVersion: 9 },
    ],
  },
];

const FLOW_URL = 'http://localhost:3000/.well-known/workflow/v1/flow';

function toRequest(headers, body) {
  return new Request(FLOW_URL, {
    method: 'POST',
    headers,
    ...(body === null ? {} : { body: encodeBody(body) }),
  });
}

/** What a response and the handler's calls look like, for comparison. */
async function record(response, calls) {
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
    calls: JSON.parse(
      encodeBody(
        calls.map(({ message, meta }) => ({
          message,
          meta: {
            attempt: meta.attempt,
            deliveryCount: meta.deliveryCount,
            createdAt: meta.createdAt,
            queueName: meta.queueName,
            messageId: meta.messageId,
          },
        }))
      )
    ),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

/**
 * Runs every case against `createQueueHandler(prefix, handler)` and returns
 * the records, keyed by case name.
 */
export async function runCases(createQueueHandler) {
  const results = {};
  for (const c of REQUEST_CASES) {
    const calls = [];
    const handle = createQueueHandler(PREFIX, async (message, meta) => {
      calls.push({ message, meta });
      if ('throws' in c.handler) throw new Error(c.handler.throws);
      return c.handler.returns;
    });
    results[c.name] = await record(
      await handle(toRequest(c.headers, c.body)),
      calls
    );
  }
  for (const c of CONCURRENCY_CASES) {
    const events = [];
    const releases = [];
    const handle = createQueueHandler(PREFIX, async (_message, meta) => {
      // The message id names the delivery (see below).
      const index = Number(meta.messageId.slice(-1));
      events.push(`start:${index}`);
      await releases[index].promise;
      events.push(`end:${index}`);
    });
    const deliveries = c.messages.map((message, index) => {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      releases[index] = { promise, release };
      return handle(
        toRequest(
          fullHeaders({
            'x-vqs-queue-name': `${PREFIX}gate`,
            'x-vqs-message-id': `msg_01PARITYGATE000000000000${index}`,
          }),
          message
        )
      );
    });
    await tick();
    events.push('release:0');
    releases[0].release();
    await deliveries[0];
    await tick();
    events.push('release:1');
    releases[1].release();
    const responses = await Promise.all(deliveries);
    results[c.name] = {
      events,
      statuses: responses.map((response) => response.status),
    };
  }
  return results;
}
