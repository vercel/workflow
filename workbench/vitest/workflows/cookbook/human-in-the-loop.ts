/**
 * Cookbook: human-in-the-loop pattern
 *
 * Demonstrates defineHook() to suspend a workflow for human approval,
 * with a timeout via sleep + Promise.race.
 */
import { defineHook, sleep } from 'workflow';

export const approvalHook = defineHook<{
  approved: boolean;
  comment?: string;
}>();

async function confirmAction(item: string) {
  'use step';
  return { confirmed: true, item };
}

export async function humanInTheLoopWorkflow(itemId: string) {
  'use workflow';

  const hook = approvalHook.create({ token: `approval:${itemId}` });

  const result = await Promise.race([
    hook.then((payload) => ({ type: 'decision' as const, ...payload })),
    sleep('24h').then(() => ({
      type: 'timeout' as const,
      approved: false as const,
    })),
  ]);

  if (result.type === 'timeout') {
    return { status: 'expired', itemId };
  }

  if (!result.approved) {
    return { status: 'rejected', itemId, comment: result.comment };
  }

  const confirmation = await confirmAction(itemId);
  return { status: 'approved', itemId, confirmed: confirmation.confirmed };
}
