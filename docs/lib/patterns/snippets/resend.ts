/**
 * Source snippets for the Resend registry entry.
 *
 * Each export is a raw string of source code that the detail page renders
 * with shiki. Keep these in sync with the canonical files in the
 * shadcn-installable registry (the Workflow + Resend example).
 *
 * Note on escaping: template literal placeholders inside the snippet (e.g.
 * `${input.email}`) are escaped as `\${...}` so they stay literal here.
 */

export const resendWorkflowSource = `import { defineHook, sleep } from "workflow";
import type { StringValue } from "ms";
import { Resend } from "resend";

export interface UserSignup {
  email: string;
  name: string;
}

// Cancellation hook — opened once per run, exported so the cancel API
// route can call \`.resume()\` on it.
export const cancelNudges = defineHook<{ reason?: string }>();

export async function emailSequence(
  input: UserSignup,
  // Defaults to "2d". Pass a short duration like "5s" to demo end-to-end
  // without waiting days. Accepts any duration string \`sleep()\` supports.
  interval: StringValue = "2d"
) {
  "use workflow";

  // 1. Persist the signup (your DB / CRM call lives in storeUser).
  await storeUser(input);

  // 2. Send the welcome email immediately.
  await sendWelcomeEmail(input);

  // 3. Open the cancel-nudges hook ONCE for the whole campaign. We race it
  //    against each sleep; if \`.resume()\` is called on this token, every
  //    future \`await hook\` resolves immediately.
  //
  //    AGENT — don't create a second hook with the same token in the same
  //    run. The first one is still pending (it lost a race) and the runtime
  //    will throw \`HookConflictError\`. Reuse this single hook across every
  //    cancellable sleep below.
  const cancelHook = cancelNudges.create({
    token: \`cancel-nudges:\${input.email}\`,
  });

  // 4. Wait \`interval\` OR exit early if the user takes the desired action.
  if (
    await Promise.race([
      sleep(interval).then(() => false),
      cancelHook.then(() => true),
    ])
  ) {
    return { status: "cancelled" as const, email: input.email };
  }

  // 5. First nudge.
  await sendFirstNudge(input);

  // 6. Wait again — same hook, raced against a fresh sleep.
  if (
    await Promise.race([
      sleep(interval).then(() => false),
      cancelHook.then(() => true),
    ])
  ) {
    return { status: "cancelled" as const, email: input.email };
  }

  // 7. Second (and final) nudge.
  await sendSecondNudge(input);

  return { status: "drip-complete" as const, email: input.email };
}

async function storeUser(user: UserSignup) {
  "use step";
  // Replace with your DB / CRM call:
  //   await db.insert(users).values({ email: user.email, name: user.name });
  console.log(\`Stored signup for \${user.email}\`);
}

async function sendWelcomeEmail(user: UserSignup) {
  "use step";
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: user.email,
    subject: \`Welcome, \${user.name}!\`,
    html: \`<p>Hey \${user.name},</p>
      <p>Thanks for signing up! We're excited to have you on board.</p>\`,
  });
}

async function sendFirstNudge(user: UserSignup) {
  "use step";
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: user.email,
    subject: \`\${user.name}, check out what you can build\`,
    html: \`<p>Hey \${user.name},</p>
      <p>Now that you're set up, here are a few things to try…</p>\`,
  });
}

async function sendSecondNudge(user: UserSignup) {
  "use step";
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: user.email,
    subject: \`\${user.name}, you're missing out\`,
    html: \`<p>Hey \${user.name},</p>
      <p>Need help getting started? Just reply to this email.</p>\`,
  });
}
`;

export const resendWorkflowInstallSource = `/**
 * Resend — drip email sequence with cancellation.
 *
 * THE PATTERN:
 *   1. On signup, store the user and send an immediate welcome email.
 *   2. Open a cancelNudges hook (token = email) once — it persists for the
 *      entire campaign so any race() below can fire it.
 *   3. Race each sleep() against the hook. If the hook fires (user converts,
 *      unsubscribes, or re-signs-up), exit early without sending more email.
 *   4. If the sleep wins, send the nudge and continue to the next sleep.
 *
 * USEFUL WHEN:
 *   - Sending a welcome → nudge → nudge drip sequence after signup.
 *   - You need the sequence to stop early if the user takes the desired action.
 *   - You want crash-safe delivery without a job queue or scheduler.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Add more nudge steps following the same sleep → race → send pattern.
 *   - Replace storeUser with your real DB / CRM call.
 *   - Replace the Resend email bodies with your real HTML templates.
 *   - Tune the interval parameter (default "2d") — pass "5s" to test fast.
 *   - The cancel route calls cancelNudges.resume(email) to stop the sequence;
 *     fire this on checkout, unsubscribe, or any conversion event.
 *
 * IMPORTANT: Create the cancelHook ONCE before the first race, not inside
 * each sleep block. Re-creating it with the same token would throw
 * HookConflictError because the first hook is still pending.
 *
 * DOCS: https://workflow-sdk.dev/patterns/resend
 */
import { defineHook, sleep } from "workflow";
import type { StringValue } from "ms";
import { Resend } from "resend";

export interface UserSignup {
  email: string;
  name: string;
}

// Exported so the cancel API route can call .resume() to stop the sequence.
export const cancelNudges = defineHook<{ reason?: string }>();

export async function emailSequence(
  input: UserSignup,
  interval: StringValue = "2d"
) {
  "use workflow";

  await storeUser(input);
  await sendWelcomeEmail(input);

  // Create the hook ONCE before any race. Reuse this single hook across
  // every cancellable sleep — do NOT recreate it inside the loop.
  const cancelHook = cancelNudges.create({
    token: \`cancel-nudges:\${input.email}\`,
  });

  // First wait: sleep OR cancel.
  if (await Promise.race([sleep(interval).then(() => false), cancelHook.then(() => true)])) {
    return { status: "cancelled" as const, email: input.email };
  }

  await sendFirstNudge(input);

  // Second wait: same hook, fresh sleep.
  if (await Promise.race([sleep(interval).then(() => false), cancelHook.then(() => true)])) {
    return { status: "cancelled" as const, email: input.email };
  }

  await sendSecondNudge(input);

  return { status: "drip-complete" as const, email: input.email };
}

async function storeUser(user: UserSignup) {
  "use step";
  // Replace with your DB / CRM call:
  //   await db.insert(users).values({ email: user.email, name: user.name });
  console.log(\`Stored signup for \${user.email}\`);
}

async function sendWelcomeEmail(user: UserSignup) {
  "use step";
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: user.email,
    subject: \`Welcome, \${user.name}!\`,
    html: \`<p>Hey \${user.name},</p><p>Thanks for signing up!</p>\`,
  });
}

async function sendFirstNudge(user: UserSignup) {
  "use step";
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: user.email,
    subject: \`\${user.name}, check out what you can build\`,
    html: \`<p>Hey \${user.name},</p><p>Here are a few things to try…</p>\`,
  });
}

async function sendSecondNudge(user: UserSignup) {
  "use step";
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: user.email,
    subject: \`\${user.name}, you're missing out\`,
    html: \`<p>Hey \${user.name},</p><p>Need help getting started?</p>\`,
  });
}
`;

export const resendStartRouteSource = `import { start } from "workflow/api";
import type { StringValue } from "ms";
import { NextResponse } from "next/server";
import {
  cancelNudges,
  emailSequence,
} from "@/app/workflows/resend-workflow";

export async function POST(req: Request) {
  const { name, email, interval } = (await req.json()) as {
    name?: string;
    email?: string;
    interval?: StringValue;
  };

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  // If a previous campaign is still alive for this email it is holding the
  // hook token — fire its hook so it exits cleanly before we start a new run.
  try {
    await cancelNudges.resume(\`cancel-nudges:\${email}\`, {
      reason: "Restarted by new signup",
    });
  } catch {
    // No active hook — nothing to cancel.
  }

  const run = await start(emailSequence, [
    { name: name ?? "there", email },
    interval ?? "2d",
  ]);

  return NextResponse.json({ runId: run.runId, email });
}
`;

export const resendCancelRouteSource = `import { NextResponse } from "next/server";
import { cancelNudges } from "@/app/workflows/resend-workflow";

export async function POST(req: Request) {
  const { email, reason } = await req.json();

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  try {
    await cancelNudges.resume(\`cancel-nudges:\${email}\`, {
      reason: reason ?? "User completed action",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : "";
    if (msg.includes("not found") || msg.includes("expired")) {
      return NextResponse.json({
        success: true,
        email,
        note: "No active nudge sequence (already completed or cancelled)",
      });
    }
    throw error;
  }

  return NextResponse.json({ success: true, email });
}
`;

export const resendUsageSource = `import { start } from "workflow/api";
import { emailSequence } from "@/app/workflows/resend-workflow";

// Anywhere in your app — e.g. a /signup API route — kick off the campaign:
const run = await start(emailSequence, [
  { name: "Jane", email: "jane@example.com" },
  "2d", // interval between nudges; pass "5s" to demo end-to-end
]);

console.log("Drip started:", run.runId);
`;
