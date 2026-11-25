// Compile the e2e workflows with the package's own build helper, from the
// built package (`pnpm build` first), so the suite exercises what is published.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCloudflareWorkflows } from '../dist/build.js';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const { deploymentId, workflowIds } = await buildCloudflareWorkflows({
  cwd: e2eDir,
  dirs: ['workflows'],
});
console.log(
  `[world-cloudflare e2e] built ${Object.keys(workflowIds).length} workflow ids, ${deploymentId}`
);
