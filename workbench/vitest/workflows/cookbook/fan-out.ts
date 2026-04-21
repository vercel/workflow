async function sendSlack(
  id: string,
  msg: string
): Promise<{ channel: string }> {
  'use step';
  return { channel: 'slack' };
}

async function sendEmail(
  id: string,
  msg: string
): Promise<{ channel: string }> {
  'use step';
  return { channel: 'email' };
}

async function sendSms(id: string, msg: string): Promise<{ channel: string }> {
  'use step';
  return { channel: 'sms' };
}

export async function fanOutWorkflow(incidentId: string, message: string) {
  'use workflow';

  const settled = await Promise.allSettled([
    sendSlack(incidentId, message),
    sendEmail(incidentId, message),
    sendSms(incidentId, message),
  ]);

  const ok = settled.filter((r) => r.status === 'fulfilled').length;
  return { incidentId, delivered: ok, failed: settled.length - ok };
}
