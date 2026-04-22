# Resume routing

Load this file when the source pauses for Signals, `step.waitForEvent()`, or `.waitForTaskToken`.

## Quick route recipes

| Situation | Route keys | Must emit | Must not emit |
| --- | --- | --- | --- |
| App resumes the workflow from server-side code with a deterministic business token | `resume/internal` | `createHook()`, `resumeHook()`, deterministic `token` | `createWebhook()`, `webhook.url` |
| External vendor needs a generated callback URL and the default `202 Accepted` response is fine | `resume/url/default` | `createWebhook()`, `webhook.url` | `resumeHook()`, `respondWith: 'manual'`, `RequestWithResponse`, invented callback route |
| External vendor needs a generated callback URL and the prompt requires a custom response body, status, or headers | `resume/url/manual` | `createWebhook({ respondWith: 'manual' })`, `webhook.url`, `RequestWithResponse`, step-level `request.respondWith()` | `resumeHook()`, `token:` on `createWebhook()` |
| Target is self-hosted | `runtime/self-hosted` | `World extends Queue, Streamer, Storage`, `startWorkflowWorld()` | claims of managed execution |
| Prompt explicitly names Hono, Express, Fastify, NestJS, or Next.js | `boundary/named-framework` | user-authored app-boundary code in that framework | plain `Request` / `Response` app-boundary code |
| Prompt explicitly asks for framework-agnostic output | `boundary/framework-agnostic` | plain `Request` / `Response` app-boundary code | framework-specific route syntax |

## Selection rules

1. If the source pauses for Signals, `step.waitForEvent()`, or `.waitForTaskToken`, pick exactly one resume key.
2. If the target is self-hosted, also pick `runtime/self-hosted`.
3. Pick exactly one boundary key when the prompt explicitly requests framework-agnostic output or names a framework.
4. If the prompt under-specifies response semantics for a callback-URL flow, default to `resume/url/default` and make the assumption explicit in `## Open Questions`.
5. Only choose `resume/url/manual` when the prompt explicitly requires a custom response body, status, headers, or manual-response handling.
6. If the prompt later states that the app resumes from server-side code with a stable business token, override any callback-URL default to `resume/internal`.

## Route-key obligations

### `resume/internal`

- Workflow code must use `createHook()`.
- App boundary must call `resumeHook()`.
- Use a deterministic business token.
- Do not emit `createWebhook()` or `webhook.url`.

### `resume/url/default`

- Workflow code must use `createWebhook()`.
- External request setup must pass `webhook.url`.
- In `## App Boundary / Resume Endpoints`, treat the generated `webhook.url` as the resume surface.
- Do not emit `resumeHook(...)`.
- Do not pass `token:` to `createWebhook()`.
- Do not invent a user-authored callback route or `resumeWebhook()` wrapper unless the prompt explicitly asks for one.

### `resume/url/manual`

- Workflow code must use `createWebhook({ respondWith: 'manual' })`.
- External request setup must pass `webhook.url`.
- Use `RequestWithResponse`.
- `request.respondWith()` must stay inside a `"use step"` function.
- Do not emit `resumeHook(...)`.
- Do not pass `token:` to `createWebhook()`.
- Do not invent a user-authored callback route or `resumeWebhook()` wrapper unless the prompt explicitly asks for one.

### `runtime/self-hosted`

- Include `interface World extends Queue, Streamer, Storage { start?(): Promise<void>; }`.
- Include `startWorkflowWorld(): Promise<void>`.
- Include the explicit note that workflow/step code can stay the same while deployment still needs a custom `World`.
- Do not claim managed execution.

### `boundary/framework-agnostic`

- Use plain `Request` / `Response`.

### `boundary/named-framework`

- Use the named framework's syntax for every user-authored app-boundary snippet.
- Do not mix named-framework app-boundary code with plain `Request` / `Response` unless the prompt explicitly asks for framework-agnostic output.

## Exact planning shape

```md
## Migration Plan
- Source: [Temporal | Inngest | AWS Step Functions | Trigger.dev]
- Route keys: [comma-separated keys]
- Why these route keys:
  - [route key]: [reason from the prompt]
- Required code obligations:
  - [obligation 1]
  - [obligation 2]
```

Sample input and expected output:

- Input: _The vendor needs a callback URL. Default 202 is fine._ → Expected route keys: `resume/url/default`
- Input: _The vendor needs a callback URL and requires a 200 JSON acknowledgement body._ → Expected route keys: `resume/url/manual`
- Input: _Approval API resumes by orderId in Hono._ → Expected route keys: `resume/internal`, `boundary/named-framework`
