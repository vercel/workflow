---
"@workflow/world-vercel": minor
---

Add v4 event API client: `createWorkflowRunEventV4`, `getEventV4`, `getWorkflowRunEventsV4`. Sends event metadata via `x-wf-*` headers and treats payloads as opaque bytes (streamed end-to-end), eliminating server-side CBOR parsing and the `/refs` round-trip on list responses. The world-vercel adapter still uses the v3 path by default; v4 is exposed for direct callers and a follow-up will switch the adapter over.
