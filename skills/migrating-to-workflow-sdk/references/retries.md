# Retry mechanics

Canonical reference for how the Workflow SDK models step-level retries. Load this file when translating Temporal retry policies, Inngest step retries, trigger.dev retry options, or AWS Step Functions `Retry` blocks.

The SDK exposes exactly three knobs. Nothing else is configurable at the step boundary.

## 1. Attempt count — `stepFn.maxRetries = N`

Set retry count as a property on the step function. It is a count only; it does not configure backoff.

```ts
async function chargePayment(orderId: string) {
  'use step';
  await fetch('https://payments.example.com/charge', {
    method: 'POST',
    body: JSON.stringify({ orderId }),
  });
}
chargePayment.maxRetries = 5;
```

- Default is implementation-defined; pick an explicit value if the source framework specified one.
- No options object is accepted. `stepFn.maxRetries = N` is the only supported syntax.
- `maxRetries` controls *attempts*, not delay between attempts.

## 2. Delay between attempts — `new RetryableError(msg, { retryAfter })`

Push the next retry into the future by throwing `RetryableError` with a `retryAfter` value (milliseconds, duration string, or Date). Use this when the source framework specified exponential backoff, a fixed delay, or a custom backoff policy.

```ts
import { RetryableError } from 'workflow';

async function callRateLimitedApi(orderId: string) {
  'use step';
  const response = await fetch(`https://api.example.com/orders/${orderId}`);
  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get('retry-after') ?? 30);
    throw new RetryableError('rate limited', { retryAfter: retryAfterSeconds * 1000 });
  }
}
callRateLimitedApi.maxRetries = 10;
```

- `retryAfter` accepts milliseconds (number), a duration string (e.g. `'30s'`, `'2m'`), or a `Date` object.
- There is no built-in exponential-backoff helper. If the source used one, compute the delay in userland and pass it as `retryAfter`.
- Automatic VQS scheduling handles the default retry cadence when `retryAfter` is not provided.

## 3. Give up — `throw new FatalError(msg)`

Abort retries immediately. Use this for non-recoverable errors such as validation failures or 4xx responses that will never succeed.

```ts
import { FatalError } from 'workflow';

async function validatePayload(input: unknown) {
  'use step';
  if (typeof input !== 'object' || input === null) {
    throw new FatalError('invalid payload');
  }
}
```

- `FatalError` bypasses `maxRetries` and surfaces to the workflow caller.

## What is *not* configurable at the step boundary

- Per-attempt timeout. Implement with `Promise.race(step(), sleep('30s'))` and `AbortSignal.timeout()` inside the step for network cancellation.
- Backoff coefficient / initial interval / maximum interval. Derive the delay in userland and pass to `RetryableError({ retryAfter })`.
- Non-retryable error classification by type name. Use `FatalError` to stop retries; use `RetryableError` to continue.
- Jitter. If the source framework used `randomize`, add jitter in userland before throwing `RetryableError`.

## Mapping from source frameworks

| Source concept | Workflow SDK equivalent |
| --- | --- |
| Temporal `maximumAttempts` | `stepFn.maxRetries = N` |
| Temporal `startToCloseTimeout` | `Promise.race(step(), sleep(...))` inside the workflow |
| Temporal `initialInterval` / `backoffCoefficient` | compute delay in userland, throw `RetryableError({ retryAfter })` |
| Temporal `nonRetryableErrorTypes` | `throw new FatalError(msg)` for those error classes |
| Inngest `retries: N` | `stepFn.maxRetries = N` |
| Inngest `NonRetriableError` | `throw new FatalError(msg)` |
| Inngest `RetryAfterError` | `throw new RetryableError(msg, { retryAfter })` |
| Trigger.dev `retry.maxAttempts` | `stepFn.maxRetries = N` |
| Trigger.dev `retry.factor` / `randomize` / `maxTimeoutInMs` | compute delay in userland, throw `RetryableError({ retryAfter })` |
| Trigger.dev `AbortTaskRunError` | `throw new FatalError(msg)` |
| AWS SF `Retry.MaxAttempts` | `stepFn.maxRetries = N` |
| AWS SF `Retry.IntervalSeconds` / `BackoffRate` | compute delay in userland, throw `RetryableError({ retryAfter })` |
| AWS SF `Catch` | try/catch in workflow body; call compensating step |

## Links

- `docs/content/docs/foundations/errors-and-retries.mdx` — the canonical user-facing docs page.
- `packages/core/src/private.ts:12-17` — `StepFunction.maxRetries` type definition.
- `packages/errors/src/index.ts` — `RetryableError` and `FatalError` implementations.
