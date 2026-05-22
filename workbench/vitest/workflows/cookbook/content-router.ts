async function classify(subject: string): Promise<{ ticketType: string }> {
  'use step';
  const lower = subject.toLowerCase();
  if (lower.includes('invoice') || lower.includes('charge')) {
    return { ticketType: 'billing' };
  }
  if (lower.includes('error') || lower.includes('bug')) {
    return { ticketType: 'technical' };
  }
  return { ticketType: 'general' };
}

async function handleBilling(ticketId: string): Promise<string> {
  'use step';
  return 'handled-billing';
}

async function handleTechnical(ticketId: string): Promise<string> {
  'use step';
  return 'handled-technical';
}

async function handleGeneral(ticketId: string): Promise<string> {
  'use step';
  return 'handled-general';
}

export async function contentRouterWorkflow(ticketId: string, subject: string) {
  'use workflow';

  const { ticketType } = await classify(subject);

  let result: string;
  if (ticketType === 'billing') {
    result = await handleBilling(ticketId);
  } else if (ticketType === 'technical') {
    result = await handleTechnical(ticketId);
  } else {
    result = await handleGeneral(ticketId);
  }

  return { ticketId, routedTo: ticketType, result };
}
