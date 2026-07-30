/**
 * Source snippets for the Sequential & Parallel registry entry.
 *
 * Three composition primitives in one file: sequential `await` for pipelines,
 * `Promise.all` for fan-out, and `Promise.race` against `sleep()` for
 * deadlines. Drop in and replace the placeholder steps with real work.
 */

export const sequentialAndParallelWorkflowSource = `import { sleep } from "workflow";

// PIPELINE — sequential await chains dependent steps.
export async function dataPipeline(data: unknown) {
  "use workflow";

  const validated = await validateData(data);
  const processed = await processData(validated);
  const stored = await storeData(processed);

  return stored;
}

// FAN-OUT — independent work runs in parallel via Promise.all.
export async function fetchUserData(userId: string) {
  "use workflow";

  const [user, orders, preferences] = await Promise.all([
    fetchUser(userId),
    fetchOrders(userId),
    fetchPreferences(userId),
  ]);

  return { user, orders, preferences };
}

// RACE — return whichever resolves first; pair with sleep() for deadlines.
export async function firstResponse(userId: string) {
  "use workflow";

  const result = await Promise.race([
    fetchPrimary(userId),
    fetchFallback(userId),
    sleep("5s").then(() => ({ stale: true } as const)),
  ]);

  return result;
}

// Replace each step body with your real logic — all of Node.js is available.

async function validateData(data: unknown): Promise<string> {
  "use step";
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid input");
  }
  return JSON.stringify(data);
}

async function processData(data: string): Promise<string> {
  "use step";
  return data.trim();
}

async function storeData(data: string): Promise<string> {
  "use step";
  return \`stored:\${data.length}\`;
}

async function fetchUser(userId: string): Promise<{ id: string; name: string }> {
  "use step";
  return { id: userId, name: "Ada" };
}

async function fetchOrders(userId: string): Promise<{ id: string; items: number }[]> {
  "use step";
  return [{ id: "o_1", items: 3 }];
}

async function fetchPreferences(userId: string): Promise<{ theme: string }> {
  "use step";
  return { theme: "dark" };
}

async function fetchPrimary(userId: string): Promise<{ source: "primary"; userId: string }> {
  "use step";
  return { source: "primary", userId };
}

async function fetchFallback(userId: string): Promise<{ source: "fallback"; userId: string }> {
  "use step";
  return { source: "fallback", userId };
}
`;

export const sequentialAndParallelWorkflowInstallSource = `/**
 * Sequential & Parallel Execution — the three step composition primitives.
 *
 * THE PATTERN:
 *   SEQUENTIAL (pipeline): await each step in order when steps are dependent
 *     — the output of one feeds the input of the next.
 *
 *   PARALLEL (fan-out): Promise.all() for independent steps that can run
 *     concurrently — collects all results before continuing.
 *
 *   RACE: Promise.race() returns the first result; pair with sleep() for
 *     deadlines or with a fallback fetch for primary/secondary failover.
 *
 * USEFUL WHEN:
 *   - You need a data transformation pipeline (validate → process → store).
 *   - You fetch multiple independent resources and need all of them.
 *   - You want to bound how long a slow step can take with a deadline.
 *   - You have a primary API with a fast fallback.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Keep only the patterns you need — all three are shown for reference.
 *   - Replace step bodies with your real work. All of Node.js is available.
 *   - For Promise.all with failure isolation (one failure = don't throw),
 *     use Promise.allSettled() instead (see the Batching pattern).
 *   - The TIMEOUT sentinel pattern (Symbol) is type-safe: TypeScript narrows
 *     the union correctly without a discriminant string field.
 *
 * DOCS: https://workflow-sdk.dev/patterns/sequential-and-parallel
 */
import { sleep } from "workflow";

// PIPELINE — sequential await chains dependent steps.
export async function dataPipeline(data: unknown) {
  "use workflow";

  const validated = await validateData(data);
  const processed = await processData(validated);
  const stored = await storeData(processed);

  return stored;
}

// FAN-OUT — independent work runs in parallel via Promise.all.
export async function fetchUserData(userId: string) {
  "use workflow";

  // All three steps fire concurrently; the workflow awaits all of them.
  const [user, orders, preferences] = await Promise.all([
    fetchUser(userId),
    fetchOrders(userId),
    fetchPreferences(userId),
  ]);

  return { user, orders, preferences };
}

// RACE — return whichever resolves first; sleep() provides the deadline.
export async function firstResponse(userId: string) {
  "use workflow";

  const result = await Promise.race([
    fetchPrimary(userId),
    fetchFallback(userId),
    // After 5s, return a stale sentinel — caller decides how to handle it.
    sleep("5s").then(() => ({ stale: true } as const)),
  ]);

  return result;
}

// Replace each step body with your real logic — all of Node.js is available.

async function validateData(data: unknown): Promise<string> {
  "use step";
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid input");
  }
  return JSON.stringify(data);
}

async function processData(data: string): Promise<string> {
  "use step";
  return data.trim();
}

async function storeData(data: string): Promise<string> {
  "use step";
  return \`stored:\${data.length}\`;
}

async function fetchUser(userId: string): Promise<{ id: string; name: string }> {
  "use step";
  return { id: userId, name: "Ada" };
}

async function fetchOrders(userId: string): Promise<{ id: string; items: number }[]> {
  "use step";
  return [{ id: "o_1", items: 3 }];
}

async function fetchPreferences(userId: string): Promise<{ theme: string }> {
  "use step";
  return { theme: "dark" };
}

async function fetchPrimary(userId: string): Promise<{ source: "primary"; userId: string }> {
  "use step";
  return { source: "primary", userId };
}

async function fetchFallback(userId: string): Promise<{ source: "fallback"; userId: string }> {
  "use step";
  return { source: "fallback", userId };
}
`;

export const sequentialAndParallelStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { fetchUserData } from "@/app/workflows/sequential-and-parallel";

// POST /api/sequential-and-parallel { userId }
export async function POST(request: Request) {
  const { userId } = await request.json();
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const run = await start(fetchUserData, [userId]);
  return NextResponse.json({ runId: run.runId });
}
`;
