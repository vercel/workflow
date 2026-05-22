import { FatalError } from 'workflow';

async function reserveInventory(orderId: string): Promise<string> {
  'use step';
  return `reservation-${orderId}`;
}

async function releaseInventory(reservationId: string): Promise<void> {
  'use step';
  // compensation: release the reservation
}

async function chargePayment(orderId: string): Promise<string> {
  'use step';
  return `invoice-${orderId}`;
}

async function refundPayment(invoiceId: string): Promise<void> {
  'use step';
  // compensation: refund the payment
}

async function provisionAccess(orderId: string): Promise<string> {
  'use step';
  throw new FatalError('Provisioning failed');
}

export async function sagaWorkflow(orderId: string) {
  'use workflow';

  const compensations: Array<() => Promise<void>> = [];

  try {
    const reservationId = await reserveInventory(orderId);
    compensations.push(() => releaseInventory(reservationId));

    const invoiceId = await chargePayment(orderId);
    compensations.push(() => refundPayment(invoiceId));

    // This step throws FatalError, triggering rollback
    const entitlementId = await provisionAccess(orderId);

    return { status: 'completed' };
  } catch (error) {
    if (!FatalError.is(error)) throw error;

    // Unwind compensations in reverse order
    while (compensations.length > 0) {
      await compensations.pop()!();
    }

    return { status: 'rolled_back' };
  }
}
