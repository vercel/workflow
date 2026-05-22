/**
 * Cookbook: durable-agent pattern (simplified without @workflow/ai)
 *
 * Demonstrates the core pattern: a workflow that calls step functions
 * (simulating tool calls) and returns results. In the full pattern,
 * DurableAgent from @workflow/ai wraps this with LLM orchestration.
 *
 * @workflow/ai is not in the vitest workbench dependencies, so this
 * demo exercises the underlying "use workflow" + "use step" primitives.
 */

async function searchFlights({
  from,
  to,
  date,
}: {
  from: string;
  to: string;
  date: string;
}) {
  'use step';
  return {
    flights: [
      { id: 'FL-100', price: 299 },
      { id: 'FL-200', price: 349 },
    ],
  };
}

async function bookFlight({
  flightId,
  passenger,
}: {
  flightId: string;
  passenger: string;
}) {
  'use step';
  return { confirmationId: `CONF-${flightId}` };
}

export async function durableAgentWorkflow(from: string, to: string) {
  'use workflow';

  const { flights } = await searchFlights({ from, to, date: '2026-04-01' });
  const cheapest = flights.sort((a, b) => a.price - b.price)[0];
  const booking = await bookFlight({
    flightId: cheapest.id,
    passenger: 'Alice',
  });

  return { flightId: cheapest.id, confirmationId: booking.confirmationId };
}
