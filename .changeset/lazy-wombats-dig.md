---
"@workflow/core": patch
---

add waitUntil wrapping for toplevel commands for transaction-like behavior

when deployed on Vercel or other serverless providers, we must signal that we need to wait until operations are done before the function can halt the request.

This means that we can't rely on discrete operations (like Queue.queue or Storage calls), and instead wrap the entire `start` function (which calls multiple discrete operations) in a single `await waitUntil` call.
