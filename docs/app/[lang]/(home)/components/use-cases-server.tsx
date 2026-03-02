import { CodeBlock } from '@/app/[lang]/(home)/components/code-block';
import { UseCasesClient } from './use-cases-client';

const useCases = [
  {
    id: 'ai-agents',
    label: 'AI Agents',
    code: `export async function aiAgentWorkflow(query: string) {
  "use workflow";

  // Step 1: Generate initial response
  const response = await generateResponse(query);

  // Step 2: Research and validate
  const facts = await researchFacts(response);

  // Step 3: Refine with fact-checking
  const refined = await refineWithFacts(response, facts);

  return { response: refined, sources: facts };
}`,
  },
  {
    id: 'retrying',
    label: 'Retrying',
    code: `import { RetryableError, FatalError } from "workflow";

async function callAPI(endpoint) {
  "use step";

  const response = await fetch(endpoint);

  if (response.status >= 500) {
    // Uncaught exceptions are retried by default
    throw new Error("Server error");
  }

  if (response.status === 404) {
    // Explicitly throw a FatalError to skip retrying
    throw new FatalError("Resource not found. Skipping retries.");
  }

  if (response.status === 429) {
    // Customize retry delay - accepts duration strings, milliseconds, or Date instances
    throw new RetryableError("Too many requests. Retrying...", {
      retryAfter: "30s"
    });
  }

  return response.json();
}

// Customize max retries
callAPI.maxRetries = 5;`,
  },
  {
    id: 'sleep',
    label: 'Sleep',
    code: `import { sleep } from "workflow";

export async function sendBirthdayCard(birthday: Date) {
  "use workflow";

  // Sleep for minutes, days, weeks or even months
  await sleep("5 days");

  // Or sleep until a certain date
  await sleep(birthday);

  // The workflow consumes no resources while asleep

  await sendBirthdayCard();
};`,
  },
  {
    id: 'webhook',
    label: 'Webhook',
    code: `import { createWebhook, fetch } from "workflow";

export async function validatePaymentMethod(rideId) {
  "use workflow";

  // Create a new webhook
  const webhook = createWebhook();

  // Every webhook has a url that can be used to resume
  // the workflow
  await fetch("https://api.example-payments.com/validate-method", {
    method: "POST",
    body: JSON.stringify({ rideId, callback: webhook.url }),
  });

  // Suspend the workflow until the webhook is invoked
  const { request } = await webhook;

  const confirmation = await request.json();

  return { rideId, status: confirmation.status };
}`,
  },
  {
    id: 'streaming',
    label: 'Streaming',
    code: `import { getWritable } from "workflow";

export async function streamWorkflow() {
  "use workflow";

  // Get the workflow's writable stream
  const writable = getWritable();

  // And send it into a step
  await writeStream(writable, 'Hello, world!');
}

async function writeStream(writable: WritableStream, data: string) {
  "use step";

  // Steps can write to the stream
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(data));
  writer.close();
};

const run = await start(streamWorkflow); // Start the workflow
const stream = run.readable; // Consume the readable stream`,
  },
  {
    id: 'concurrency',
    label: 'Concurrency',
    code: `export async function getUserDetails(userId: string) {
  "use workflow";

  // Running steps in parallel just uses Promise.all
  const [user, orders, preferences] = await Promise.all([
    fetchUser(userId),
    fetchOrders(userId),
    fetchPreferences(userId)
  ]);

  // Use Promise.race to get the fastest response from multiple sources
  const inventory = await Promise.race([
    fetchFromUSWarehouse(userId),
    fetchFromEUWarehouse(userId),
    sleep("10m")
  ]);

  return { user, orders, preferences, inventory };
}`,
  },
];

export const UseCases = async () => {
  const codeBlocks = await Promise.all(
    useCases.map(async (useCase) => ({
      id: useCase.id,
      label: useCase.label,
      codeBlock: (
        <CodeBlock
          code={useCase.code}
          lang="ts"
          codeblock={{
            className: 'shadow-none !bg-background dark:bg-sidebar rounded-md',
          }}
        />
      ),
    }))
  );

  return <UseCasesClient useCases={codeBlocks} />;
};
