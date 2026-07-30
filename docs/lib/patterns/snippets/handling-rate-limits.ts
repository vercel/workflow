/**
 * Source snippets for the Handling Rate Limits registry entry.
 *
 * Throw RetryableError with a Retry-After value and the workflow runtime
 * reschedules the step automatically — no manual sleep-retry loops. Includes
 * exponential-backoff variant via getStepMetadata().
 */

export const handlingRateLimitsWorkflowSource = `import { RetryableError, getStepMetadata } from "workflow";

export async function syncContact(contactId: string) {
  "use workflow";

  const contact = await fetchFromCrm(contactId);
  await upsertToWarehouse(contactId, contact);

  return { contactId, status: "synced" as const };
}

// 429 — read Retry-After and let the runtime reschedule us.
async function fetchFromCrm(contactId: string): Promise<unknown> {
  "use step";

  const res = await fetch(\`https://crm.example.com/contacts/\${contactId}\`);

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new RetryableError("Rate limited by CRM", {
      retryAfter: retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : "1m",
    });
  }

  if (!res.ok) {
    throw new Error(\`CRM returned \${res.status}\`);
  }

  return res.json();
}

// 5xx + 429 — exponential backoff using the current attempt number.
async function upsertToWarehouse(
  contactId: string,
  contact: unknown,
): Promise<void> {
  "use step";

  const { attempt } = getStepMetadata();
  const res = await fetch(\`https://warehouse.example.com/contacts/\${contactId}\`, {
    method: "PUT",
    body: JSON.stringify(contact),
  });

  if (res.status === 429 || res.status >= 500) {
    throw new RetryableError(\`Warehouse error \${res.status}\`, {
      retryAfter: attempt ** 2 * 1000, // 1s, 4s, 9s...
    });
  }

  if (!res.ok) {
    throw new Error(\`Warehouse returned \${res.status}\`);
  }
}

// Allow more retries than the default of 3 for known-flaky endpoints.
upsertToWarehouse.maxRetries = 10;
`;

export const handlingRateLimitsWorkflowInstallSource = `/**
 * Handling Rate Limits — handle 429s and back-pressure without manual sleep loops.
 *
 * THE PATTERN:
 *   1. On a 429 response, throw RetryableError with a retryAfter value
 *      (milliseconds or a duration string like "1m").
 *   2. The Workflow runtime reschedules the step automatically — no
 *      manual retry loops, timers, or sleep() calls needed.
 *   3. For exponential backoff, read getStepMetadata().attempt (0-indexed)
 *      and compute the delay: attempt ** 2 * 1000 gives 1s, 4s, 9s…
 *   4. Set stepFn.maxRetries to override the 3x default for flaky endpoints.
 *
 * USEFUL WHEN:
 *   - Fetching from third-party APIs that enforce rate limits (CRMs, SaaS).
 *   - Writing to analytics warehouses or data pipelines with back-pressure.
 *   - Any external HTTP call that can transiently return 429 or 503.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace fetchFromCrm with your rate-limited GET step.
 *   - Replace upsertToWarehouse with your write step.
 *   - Adjust retryAfter values to match your provider's documented limits.
 *   - For non-HTTP back-pressure (queue depth, token bucket), compute
 *     retryAfter from your own logic and throw RetryableError the same way.
 *   - Increase maxRetries beyond 10 for very spiky endpoints.
 *
 * DOCS: https://workflow-sdk.dev/patterns/handling-rate-limits
 */
import { RetryableError, getStepMetadata } from "workflow";

export async function syncContact(contactId: string) {
  "use workflow";

  const contact = await fetchFromCrm(contactId);
  await upsertToWarehouse(contactId, contact);

  return { contactId, status: "synced" as const };
}

// 429 — read Retry-After from the response and let the runtime reschedule.
// The step will be called again after the delay; no loop or timer needed.
async function fetchFromCrm(contactId: string): Promise<unknown> {
  "use step";

  const res = await fetch(\`https://crm.example.com/contacts/\${contactId}\`);

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new RetryableError("Rate limited by CRM", {
      // Accept the provider's delay if present; default to 1 minute.
      retryAfter: retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : "1m",
    });
  }

  if (!res.ok) {
    throw new Error(\`CRM returned \${res.status}\`);
  }

  return res.json();
}

// 5xx + 429 — exponential backoff using the current attempt count.
// attempt is 0-indexed: attempt 0 → 1s wait, attempt 1 → 4s, attempt 2 → 9s…
async function upsertToWarehouse(
  contactId: string,
  contact: unknown,
): Promise<void> {
  "use step";

  const { attempt } = getStepMetadata();
  const res = await fetch(\`https://warehouse.example.com/contacts/\${contactId}\`, {
    method: "PUT",
    body: JSON.stringify(contact),
  });

  if (res.status === 429 || res.status >= 500) {
    throw new RetryableError(\`Warehouse error \${res.status}\`, {
      retryAfter: attempt ** 2 * 1000, // 1s, 4s, 9s...
    });
  }

  if (!res.ok) {
    throw new Error(\`Warehouse returned \${res.status}\`);
  }
}

// Allow more retries than the default of 3 for known-flaky endpoints.
upsertToWarehouse.maxRetries = 10;
`;

export const handlingRateLimitsStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { syncContact } from "@/app/workflows/handling-rate-limits";

// POST /api/handling-rate-limits { contactId }
export async function POST(request: Request) {
  const { contactId } = await request.json();
  if (!contactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  const run = await start(syncContact, [contactId]);
  return NextResponse.json({ runId: run.runId });
}
`;
