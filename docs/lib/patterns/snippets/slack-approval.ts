/**
 * Source snippets for the Slack Approval registry entry.
 *
 * Human-in-the-loop where the approval surface is Slack instead of your
 * app: the workflow posts an interactive message with Approve / Reject
 * buttons (the hook token rides along as the action value), suspends on
 * the hook with a deadline, and Slack's interactivity webhook resumes it
 * with the decision and who made it.
 */

const SLACK_APPROVAL_BODY = `import { defineHook, sleep } from "workflow";

// Resumed by the Slack interactivity route with the decision.
export const slackDecision = defineHook<{
  approved: boolean;
  decidedBy: string;
}>();

export function approvalToken(requestId: string) {
  return \`slack-approval:\${requestId}\`;
}

// How long to wait for a human before timing out.
const APPROVAL_TIMEOUT = "24h";

export interface ApprovalRequest {
  requestId: string;
  title: string;
  summary: string;
}

export async function requestSlackApproval(request: ApprovalRequest) {
  "use workflow";

  const decision = slackDecision.create({
    token: approvalToken(request.requestId),
  });

  await postApprovalMessage(request);

  const outcome = await Promise.race([
    decision.then((d) => ({ ...d, timedOut: false })),
    sleep(APPROVAL_TIMEOUT).then(() => ({
      approved: false,
      decidedBy: "timeout",
      timedOut: true,
    })),
  ]);

  await postResolutionMessage(request, outcome.approved, outcome.decidedBy);

  if (!outcome.approved) {
    return { requestId: request.requestId, status: "rejected" as const,
      decidedBy: outcome.decidedBy };
  }

  // Approved — do the consequential thing.
  await performApprovedAction(request);
  return { requestId: request.requestId, status: "approved" as const,
    decidedBy: outcome.decidedBy };
}

// Post the interactive message. The hook token travels in each button's
// value, so the interactivity route knows exactly which run to resume.
async function postApprovalMessage(request: ApprovalRequest): Promise<void> {
  "use step";
  const token = approvalToken(request.requestId);
  await slackApi("chat.postMessage", {
    channel: process.env.SLACK_CHANNEL_ID,
    text: \`Approval needed: \${request.title}\`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: \`*\${request.title}*\\n\${request.summary}\`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            action_id: "workflow_approve",
            value: token,
          },
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "Reject" },
            action_id: "workflow_reject",
            value: token,
          },
        ],
      },
    ],
  });
}

async function postResolutionMessage(
  request: ApprovalRequest,
  approved: boolean,
  decidedBy: string,
): Promise<void> {
  "use step";
  await slackApi("chat.postMessage", {
    channel: process.env.SLACK_CHANNEL_ID,
    text: approved
      ? \`✅ "\${request.title}" approved by \${decidedBy}\`
      : \`❌ "\${request.title}" rejected by \${decidedBy}\`,
  });
}

// THE ACTION — replace with what approval unlocks: the deploy, the refund,
// the publish.
async function performApprovedAction(request: ApprovalRequest): Promise<void> {
  "use step";
  await fetch("https://api.example.com/approved-actions", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

async function slackApi(method: string, body: unknown): Promise<void> {
  const res = await fetch(\`https://slack.com/api/\${method}\`, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${process.env.SLACK_BOT_TOKEN}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(\`Slack \${method} failed: \${data.error}\`);
  }
}
`;

export const slackApprovalWorkflowSource = SLACK_APPROVAL_BODY;

export const slackApprovalWorkflowInstallSource = `/**
 * Slack Approval — human-in-the-loop with Slack as the approval surface.
 *
 * THE PATTERN:
 *   1. The workflow posts an interactive Slack message whose buttons carry
 *      the hook token as their value, then suspends on the hook — zero
 *      compute while humans deliberate.
 *   2. Slack's interactivity webhook posts the click to your route, which
 *      resumes the hook with { approved, decidedBy }.
 *   3. A deadline race (24h default) means nobody clicking = rejection by
 *      timeout, and the requester is told either way.
 *
 * USEFUL WHEN:
 *   - Deploy gates, refund approvals, content publishing — anywhere the
 *     approvers already live in Slack.
 *   - You want approval state IN the workflow (one run = one request)
 *     instead of a table + cron.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace performApprovedAction with the consequential thing approval
 *     unlocks.
 *   - Verify Slack request signatures in the route (X-Slack-Signature,
 *     signing secret) before resuming hooks.
 *   - Add an escalation tier: on timeout, post to a different channel and
 *     wait again instead of rejecting.
 *   - For in-app approval UI instead of Slack, see Human In The Loop.
 *
 * REQUIRED ENV:
 *   - SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, SLACK_SIGNING_SECRET
 *
 * DOCS: https://workflow-sdk.dev/patterns/slack-approval
 */
${SLACK_APPROVAL_BODY}`;

export const slackApprovalRouteSource = `import { NextResponse } from "next/server";
import { slackDecision } from "@/app/workflows/slack-approval-workflow";

// POST /api/slack/interactions — Slack interactivity endpoint.
// Configure this URL in your Slack app's "Interactivity & Shortcuts".
// NOTE: verify X-Slack-Signature with your signing secret before trusting
// the payload — https://api.slack.com/authentication/verifying-requests
export async function POST(request: Request) {
  const form = await request.formData();
  const payload = JSON.parse(form.get("payload") as string);

  const action = payload.actions?.[0];
  if (!action?.value) {
    return NextResponse.json({ error: "No action" }, { status: 400 });
  }

  const approved = action.action_id === "workflow_approve";
  const decidedBy = payload.user?.username ?? payload.user?.id ?? "unknown";

  try {
    // action.value carries the hook token the workflow embedded in the
    // button — resume it with the decision.
    await slackDecision.resume(action.value, { approved, decidedBy });
  } catch {
    // Hook already resolved (double-click, or timed out) — fine.
  }

  return NextResponse.json({ ok: true });
}
`;
