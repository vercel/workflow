---
title: Common Errors
description: Reference for common Workflow DevKit errors and how to resolve them.
---

# Common Errors

## Quick Reference

| Error | Cause | Solution |
|-------|-------|----------|
| `fetch-in-workflow` | Using global fetch | Import from `workflow`, assign to `globalThis.fetch` |
| `timeout-in-workflow` | setTimeout/setInterval | Use `sleep()` instead |
| `serialization-failed` | Non-serializable data | Use supported types, plain objects |
| `start-invalid-workflow-function` | Missing directive or config | Add `'use workflow'`, check `withWorkflow()` |
| `node-js-module-in-workflow` | Node.js modules in workflow | Move to step function |
| `webhook-invalid-respond-with-value` | Wrong respondWith | Use `"manual"`, `Response`, or `undefined` |
| `webhook-response-not-sent` | Manual mode, no response | Call `request.respondWith()` |
| Dashboard shows no runs | Port mismatch or dashboard started first | Restart dashboard, use `--app-url` flag |
| 500 error on API route | Unused workflow imports | Only import APIs you actually use |

## Import Only What You Need

**Symptom:** API route returns 500 error silently.

**Cause:** Importing workflow APIs (like `fetch`, `sleep`, `FatalError`) that aren't used can cause initialization errors.

**Solution:** Only import what you actually use:
```typescript
// BAD: Importing unused APIs
import { sleep, createHook, FatalError, fetch } from "workflow";
// If you don't use sleep, FatalError, or fetch, remove them

// GOOD: Import only what's needed
import { createHook } from "workflow";
```

## fetch-in-workflow

**Error:** Global `fetch` is unavailable in workflows.

**Cause:** Workflows run in a sandboxed environment.

**Solution:**
```typescript
import { fetch } from "workflow";

export async function myWorkflow() {
  "use workflow";
  globalThis.fetch = fetch;  // Required for libraries (AI SDK)

  const response = await fetch("https://api.example.com/data");
  const data = await response.json();
}
```

## timeout-in-workflow

**Error:** `setTimeout` or `setInterval` unavailable.

**Cause:** These are non-deterministic and break replay.

**Solution:**
```typescript
import { sleep } from "workflow";

// Instead of setTimeout
await sleep("5s");

// Polling pattern instead of setInterval
while (true) {
  const status = await checkStatus(id);
  if (status === "ready") break;
  await sleep("30s");
}
```

## serialization-failed

**Error:** Data cannot be serialized.

**Cause:** Functions, class instances, Symbols, WeakMap/WeakSet.

**Solution:**
```typescript
// BAD: Function in data
const config = { callback: () => console.log("hi") };

// GOOD: Configuration data, logic in steps
const config = { logLevel: "info" };

async function processWithLogging(data: any, logLevel: string) {
  "use step";
  if (logLevel === "info") console.log(data);
  return process(data);
}
```

**Supported types:**
- Primitives: string, number, boolean, null, undefined, bigint
- Objects: plain objects, arrays, Date, RegExp, URL, URLSearchParams
- Collections: Map, Set, Headers
- Binary: ArrayBuffer, typed arrays (Uint8Array, etc.)
- Web: Request, Response, ReadableStream, WritableStream

## start-invalid-workflow-function

**Error:** Invalid workflow function.

**Cause:** Missing `"use workflow"` directive or framework config.

**Solution:**
```typescript
// 1. Add directive as FIRST statement
export async function myWorkflow(input: string) {
  "use workflow";  // Must be first
  // ... workflow code
}

// 2. Check framework config
// next.config.ts
import { withWorkflow } from "workflow/next";
export default withWorkflow({ /* config */ });

// nitro.config.ts
export default defineNitroConfig({
  modules: ["workflow/nitro"],
});
```

## node-js-module-in-workflow

**Error:** Node.js module unavailable in workflow.

**Cause:** Workflows run sandboxed for determinism.

**Restricted:** fs, path, http, https, net, dns, child_process, cluster, os, crypto, stream

**Solution:** Move Node.js code to step functions:
```typescript
// BAD: Node.js in workflow
export async function badWorkflow() {
  "use workflow";
  const fs = require("fs");  // Error!
}

// GOOD: Node.js in step
async function readFile(path: string) {
  "use step";
  const fs = require("fs");
  return fs.readFileSync(path, "utf-8");
}

export async function goodWorkflow(filePath: string) {
  "use workflow";
  const content = await readFile(filePath);  // Works!
}
```

## webhook-invalid-respond-with-value

**Error:** Invalid `respondWith` value.

**Solution:**
```typescript
// Valid options:
const webhook = createWebhook();  // Default: auto 202
const webhook = createWebhook({ respondWith: "manual" });
const webhook = createWebhook({ respondWith: new Response("OK") });
```

## webhook-response-not-sent

**Error:** Manual mode but `respondWith()` not called.

**Solution:**
```typescript
const webhook = createWebhook({ respondWith: "manual" });
const request = await webhook;

await processRequest(request);

// MUST call respondWith in manual mode
await request.respondWith(new Response("OK", { status: 200 }));
```

## Step Retry Exhaustion

**Symptom:** Step fails after max retries.

**Default retry:** 5-10 attempts with exponential backoff.

**Solution:** Handle expected failures explicitly:
```typescript
async function callAPI() {
  "use step";

  const res = await fetch("...");

  // Don't retry on client errors
  if (res.status >= 400 && res.status < 500) {
    throw new FatalError(`Client error: ${res.status}`);
  }

  // Custom retry delay
  if (res.status === 429) {
    throw new RetryableError("Rate limited", { retryAfter: "5m" });
  }

  return res;
}
```

## Streaming Errors

**Symptom:** Stream not working.

**Solution:**
```typescript
// 1. Only use in steps, not workflow
async function streamData() {
  "use step";  // Required!

  const writer = getWritable();
  await writer.write(data);
  writer.releaseLock();  // 2. Release lock!
}

// 3. Close when done
const writer = getWritable();
await writer.write(lastData);
writer.releaseLock();
await getWritable().close();  // Signal completion
```

## Hook Token Not Found

**Error:** Invalid or expired hook token.

**Cause:** Token doesn't exist, workflow completed, or token already consumed.

**Solution:**
```typescript
import { resumeHook, getHookByToken } from "workflow/api";

// Check hook status before resuming
const hookInfo = await getHookByToken(token);
if (!hookInfo || hookInfo.status !== "pending") {
  throw new Error("Hook not available");
}

await resumeHook(token, data);
```

## Dashboard Not Showing Runs

**Symptom:** `npx workflow web` shows workflows but no runs, even after triggering.

**Causes:**
1. Dashboard not connected to your app's port
2. App running on non-default port (not 3000)
3. Dashboard started before app
4. Multiple dev servers running on different ports

**Solution:**

```bash
# 1. Kill any stray dev servers
pkill -f "next dev" 2>/dev/null

# 2. Start your app on port 3000
npm run dev

# 3. In another terminal, restart the dashboard
pkill -f "workflow web" 2>/dev/null
npx workflow web

# 4. If using a different port, specify it:
npx workflow web --app-url http://localhost:3001
```

**Verify connection:**
```bash
# Check Local World backend health (workflow and step endpoints)
npx workflow health

# Check specific endpoint
npx workflow health --endpoint workflow
npx workflow health --endpoint step

# Specify port if not using default 3000
npx workflow health --port 3001

# Check Vercel backend health
npx workflow health --backend vercel --project my-project --team my-team

# Or manually check your app responds to workflow endpoints
curl -s http://localhost:3000/.well-known/workflow/v1/flow \
  -X POST -H "Content-Type: application/json"
# Should return: {"error": "Missing required headers"} (not 404)
```

**Local storage locations:**
- Next.js: `.next/workflow-data/`
- Other frameworks: `.workflow-data/`

## Debugging Tips

1. **Run `npx workflow health`** - Verifies workflow/step endpoints are reachable (use `--port` for non-default ports, `--backend vercel` for production)
2. **Use `npx workflow web`** - Visual dashboard for runs (ensure correct port)
3. **Check run status** - `getRun(runId).status`
4. **Review event log** - Shows step executions, hooks, sleeps
5. **Test locally first** - Local World for development
6. **Add logging in steps** - Steps have full console access
7. **Verify port** - Ensure dashboard connects to correct app port
