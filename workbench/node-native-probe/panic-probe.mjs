import assert from 'node:assert/strict';

const { nativePanicProbe } = await import('./binding.js');

await assert.rejects(
  () => nativePanicProbe(),
  (error) =>
    error instanceof Error &&
    error.message.includes('WORKFLOW_NATIVE_ERROR:') &&
    error.message.includes('intentional native task panic probe')
);
process.stdout.write('native panic became a Promise rejection\n');
