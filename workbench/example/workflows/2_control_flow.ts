import { FatalError, getStepMetadata, RetryableError } from 'workflow';

async function delayedMessage(ms: number, message: string): Promise<string> {
  'use step';
  console.log(`Sleeping for ${ms}ms and returning ${message}`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return `${message} (sent: ${new Date().toISOString()})`;
}

async function add(a: number, b: number): Promise<number> {
  'use step';
  console.log(`Adding ${a} and ${b} (sent: ${new Date().toISOString()})`);
  return a + b;
}

async function failingStep(): Promise<string> {
  'use step';
  throw new FatalError(`A failed step (sent: ${new Date().toISOString()})`);
}

async function retryableStep(): Promise<string> {
  'use step';
  const { attempt } = getStepMetadata();
  console.log('retryableStep attempt:', attempt);
  if (attempt === 1) {
    console.log(
      'Throwing retryable error - this will be retried after 5 seconds'
    );
    throw new RetryableError('Retryable error', {
      // Retry after 5 seconds
      retryAfter: '5s',
    });
  }
  console.log('Completing successfully');
  return 'Success';
}

export async function control_flow() {
  'use workflow';

  console.log('Control flow workflow started');

  // Demo Promise.race
  const raceResult = await Promise.race([
    delayedMessage(2000, 'I won the race!'),
    delayedMessage(10000, 'I lost the race'),
  ]);
  console.log('Race result:', raceResult);

  // Demo Promise.all
  const allResults = await Promise.all([
    delayedMessage(1000, 'First task'),
    delayedMessage(2000, 'Second task'),
    add(10, 20),
  ]);
  console.log('All results:', allResults);

  // Kick off a step now, and resolve it later
  const backgroundPromise = delayedMessage(5000, 'Background task completed');
  const foregroundResults = await Promise.all([
    delayedMessage(1000, 'First task'),
    delayedMessage(2000, 'Second task'),
  ]);
  console.log('Foreground response:', foregroundResults);
  const backgroundResult = await backgroundPromise;
  console.log('Background response:', backgroundResult);

  // Demo error handling - catch regular errors but let FatalErrors bubble up
  try {
    await failingStep();
  } catch (error) {
    // Only FatalErrors will bubble up here. Non-fatal errors are retried
    console.log('Caught error:', String(error));
  }

  // Demo retryable error - this will fail the first time,
  // and will be retried after one minute.
  await retryableStep();

  console.log('Control flow workflow completed. See logs for results.');

  return {
    raceResult,
    allResults,
    foregroundResults,
    backgroundResult,
  };
}
