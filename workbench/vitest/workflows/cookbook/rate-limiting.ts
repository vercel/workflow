import { RetryableError } from 'workflow';

let callCount = 0;

async function fetchFromApi(
  contactId: string
): Promise<{ id: string; name: string }> {
  'use step';
  callCount++;
  // Simulate rate limit on first call, succeed on retry
  if (callCount === 1) {
    throw new RetryableError('Rate limited', { retryAfter: 100 });
  }
  return { id: contactId, name: `contact-${contactId}` };
}

async function saveContact(contact: {
  id: string;
  name: string;
}): Promise<void> {
  'use step';
  // no-op save
}

export async function rateLimitWorkflow(contactId: string) {
  'use workflow';

  const contact = await fetchFromApi(contactId);
  await saveContact(contact);

  return { contactId, status: 'synced' };
}
