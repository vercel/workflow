import chunk from 'lodash.chunk';

const ARRAY_LENGTH = 250;
const CHUNK_SIZE = 50;

/**
 * Pattern 1: Each item in a batch gets processed in a step function
 *
 * If a step fails, doesn't fail the entire batch.
 */
export async function batchOverSteps() {
  'use workflow';

  console.log('Workflow started');
  const arr = Array.from({ length: ARRAY_LENGTH }, (_, i) => i + 1);
  const chunkSize = CHUNK_SIZE;
  console.log(
    `Chunking array with size: ${arr.length} and chunk size: ${chunkSize}`
  );
  const chunks = chunk(arr, chunkSize); // Create the batches
  console.log(
    `Created ${chunks.length} chunks (${chunks[0].length} items each)`
  );

  console.log('Starting batch processing');
  for (const [index, batch] of chunks.entries()) {
    console.log(`Batch ${index + 1}/${chunks.length}`);
    await Promise.all(batch.map(logItem));
  }
  console.log('Batch processing completed');
  console.log('Workflow completed');
}

async function logItem(item: number) {
  'use step';
  console.log(item, Date.now());
}

/**
 * Pattern 2: Each batch gets processed in a step function
 *
 * NOTE: If a batch fails, the entire batch will be retried from the beginning.
 */
export async function batchInStep() {
  'use workflow';

  console.log('Workflow started');
  const arr = Array.from({ length: ARRAY_LENGTH }, (_, i) => i + 1);
  const chunkSize = CHUNK_SIZE;
  console.log(
    `Chunking array with size: ${arr.length} and chunk size: ${chunkSize}`
  );
  const chunks = chunk(arr, chunkSize); // Create the batches
  console.log(
    `Created ${chunks.length} chunks (${chunks[0].length} items each)`
  );

  console.log('Starting batch processing');
  for (const [index, batch] of chunks.entries()) {
    console.log(`Batch ${index + 1}/${chunks.length}`);
    await processItems(batch);
  }
  console.log('Batch processing completed');
  console.log('Workflow completed');
}

/**
 * Step function that processes a batch of items with internal parallelism.
 * Called once per batch, with all items processed in parallel inside the step.
 */
async function processItems(items: number[]) {
  'use step';
  await Promise.all(
    items.map(async (item) => {
      console.log(item, Date.now());
    })
  );
}
