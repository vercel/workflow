export const circuitBreakerUsageSource = `import { RetryableError } from "workflow";
import {
  CircuitOpenError,
  withBreaker,
} from "@/app/workflows/circuit-breaker-workflow";

export async function notifyUser(userId: string, message: string) {
  "use workflow";

  try {
    // Every run shares the same breaker — five consecutive failures
    // anywhere open the circuit for everyone.
    return await withBreaker("notifications-api", () =>
      sendNotification(userId, message),
    );
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      // Let the runtime reschedule this step after the cooldown instead
      // of counting it as a real failure.
      throw new RetryableError("Notifications API circuit open", {
        retryAfter: "1m",
      });
    }
    throw error;
  }
}

async function sendNotification(userId: string, message: string) {
  "use step";
  const res = await fetch("https://api.notifications.example.com/send", {
    method: "POST",
    body: JSON.stringify({ userId, message }),
  });
  if (!res.ok) throw new Error(\`Notify failed: \${res.status}\`);
  return res.json();
}
`;
