import { createHook } from 'workflow';

/**
 * Collects messages for one conversation: the first arrives as an argument
 * (from the call that started the run), the rest through the run's start
 * Hook, until `expected` messages have arrived.
 */
export async function collectMessages(
  token: string,
  first: string,
  expected: number
) {
  'use workflow';

  const messages = [first];
  if (messages.length >= expected) return messages;

  const hook = createHook<string>({ token });
  for await (const message of hook) {
    messages.push(message);
    if (messages.length >= expected) break;
  }
  return messages;
}
