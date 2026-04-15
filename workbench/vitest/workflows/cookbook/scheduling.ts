import { sleep } from 'workflow';

async function sendEmail(email: string, template: string): Promise<void> {
  'use step';
  // no-op
}

export async function schedulingWorkflow(email: string) {
  'use workflow';

  await sendEmail(email, 'welcome');
  await sleep('1d');
  await sendEmail(email, 'follow-up');

  return { email, status: 'completed' };
}
