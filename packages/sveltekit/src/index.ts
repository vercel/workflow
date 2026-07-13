import path from 'node:path';
import { getWorkflowQueueTrigger } from '@workflow/builders';
import fs from 'fs-extra';

import { SvelteKitBuilder } from './builder.js';
import { stripWorkflowQueueTriggers } from './vc-config.js';

const builder = new SvelteKitBuilder();

// This needs to be in the top-level as we need to create these
// entries before svelte plugin is started or the entries are
// a race to be created before svelte discovers entries
await builder.build();

process.on('beforeExit', () => {
  // Don't patch functions output if not in Vercel adapter
  if (!process.env.VERCEL_DEPLOYMENT_ID) {
    return;
  }
  // V2: Only the combined flow handler needs queue triggers.
  // The separate step route was removed.
  for (const { file, config } of [
    {
      file: '.vercel/output/functions/.well-known/workflow/v1/flow.func/.vc-config.json',
      config: {
        maxDuration: 'max',
        experimentalTriggers: [getWorkflowQueueTrigger()],
      },
    },
  ]) {
    const funcDir = path.dirname(file);
    if (!fs.existsSync(funcDir)) {
      continue;
    }
    // Un-symlink these as they can't be shared due to different
    // experimental triggers config
    const sourceFuncDir = path.join(
      funcDir.replace(/\.func$/, ''),
      '__data.json.func'
    );
    const toCopy = fs.readdirSync(funcDir);
    fs.removeSync(funcDir);
    fs.mkdirSync(funcDir, { recursive: true });

    for (const item of toCopy) {
      fs.copySync(path.join(sourceFuncDir, item), path.join(funcDir, item));
    }

    // Update .vc-config.json with the new experimental triggers config
    const existingConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...existingConfig,
        ...config,
      })
    );

    // The source function may be a shared catchall. It must not keep stale
    // workflow queue triggers after the dedicated function is copied out.
    stripWorkflowQueueTriggers(path.join(sourceFuncDir, '.vc-config.json'));
  }
});

export { workflowPlugin } from './plugin.js';
