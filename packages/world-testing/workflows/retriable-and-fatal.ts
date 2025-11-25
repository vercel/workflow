import { FatalError, getStepMetadata, RetryableError } from 'workflow';

export async function retryableAndFatalErrorWorkflow() {
  'use workflow';

  const retryableResult = await stepThatThrowsRetryableError();

  let gotFatalError = false;
  try {
    await stepThatFails();
  } catch (error: any) {
    if (FatalError.is(error)) {
      gotFatalError = true;
    }
  }

  return { retryableResult, gotFatalError };
}

async function stepThatThrowsRetryableError() {
  'use step';
  const { attempt, stepStartedAt } = getStepMetadata();
  console.log(
    `💁 Attempt ${attempt} started at ${stepStartedAt.toISOString()}`
  );
  if (attempt === 1) {
    throw new RetryableError('Retryable error', {
      retryAfter: '2s',
    });
  }
  return {
    attempt,
    stepStartedAt,
    duration: Date.now() - stepStartedAt.getTime(),
  };
}

async function stepThatFails() {
  'use step';
  throw new FatalError('step failed');
}
