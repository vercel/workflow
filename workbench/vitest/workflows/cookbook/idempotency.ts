import { getStepMetadata } from 'workflow';

async function createCharge(
  customerId: string,
  amount: number
): Promise<{ id: string; idempotencyKey: string }> {
  'use step';

  const { stepId } = getStepMetadata();
  // In real code, stepId would be sent as Idempotency-Key header
  return { id: `charge-${customerId}`, idempotencyKey: stepId };
}

export async function idempotencyWorkflow(customerId: string, amount: number) {
  'use workflow';

  const charge = await createCharge(customerId, amount);
  return {
    customerId,
    chargeId: charge.id,
    idempotencyKey: charge.idempotencyKey,
  };
}
