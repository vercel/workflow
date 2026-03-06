import { createHook } from 'workflow';

async function processApproval(approved: boolean) {
  'use step';
  return approved ? 'approved' : 'rejected';
}

export async function hookWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean; reviewer: string }>({
    token: `approval:${documentId}`,
  });

  const decision = await hook;
  const status = await processApproval(decision.approved);

  return { status, reviewer: decision.reviewer };
}
