export const killSwitchRouteSource = `import { NextResponse } from "next/server";
import { KillSwitch } from "@/lib/kill-switch";

// POST /api/abort/[id] { reason? }
// Idempotent — triggering abort twice or after expiry is a no-op.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { reason } = (await request
    .json()
    .catch(() => ({ reason: undefined }))) as { reason?: string };

  const controller = await KillSwitch.create(id);
  await controller.abort(reason ?? "Cancelled via API");

  return NextResponse.json({ success: true, id });
}
`;

export const killSwitchButtonSource = `"use client";

import { useState } from "react";

interface CancelButtonProps {
  /** Same semantic ID used to create the controller on the server. */
  taskId: string;
  /** Optional label override. */
  label?: string;
}

export function CancelButton({ taskId, label = "Cancel" }: CancelButtonProps) {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const handleCancel = async () => {
    setPending(true);
    try {
      await fetch(\`/api/abort/\${encodeURIComponent(taskId)}\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "User clicked cancel" }),
      });
      setDone(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCancel}
      disabled={pending || done}
      className="inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
    >
      {done ? "Cancelled" : pending ? "Cancelling…" : label}
    </button>
  );
}
`;

export const killSwitchUsageSource = `// Server-side example: cancel a long-running fetch when the user clicks
// the cancel button on a different machine / tab.
import { KillSwitch } from "@/lib/kill-switch";

export async function runLongOperation(taskId: string) {
  const controller = await KillSwitch.create(taskId, {
    // Optional: shorter TTL for quick tasks.
    ttlMs: 10 * 60 * 1000, // 10 minutes
  });

  try {
    const res = await fetch("https://api.example.com/long-operation", {
      signal: controller.signal,
    });
    return await res.json();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { aborted: true, reason: controller.signal.reason };
    }
    throw err;
  }
}

// Cross-process: any other process can cancel by recreating the controller
// with the same semantic ID — no run ID sharing needed.
//
//   const same = await KillSwitch.create(taskId);
//   await same.abort("Cancelled by admin");
`;
