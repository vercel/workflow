import path from 'node:path';
import fs from 'fs-extra';

import { SvelteKitBuilder } from './builder.js';

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
  for (const { file, config } of [
    {
      file: '.vercel/output/functions/.well-known/workflow/v1/flow.func/.vc-config.json',
      config: {
        experimentalTriggers: [
          {
            type: 'queue/v2beta',
            topic: '__wkf_workflow_*',
            consumer: 'default',
            maxDeliveries: 64,
            retryAfterSeconds: 5,
            initialDelaySeconds: 0,
          },
        ],
      },
    },
    {
      file: '.vercel/output/functions/.well-known/workflow/v1/step.func/.vc-config.json',
      config: {
        experimentalTriggers: [
          {
            type: 'queue/v2beta',
            topic: '__wkf_step_*',
            consumer: 'default',
            maxDeliveries: 64,
            retryAfterSeconds: 5,
            initialDelaySeconds: 0,
          },
        ],
      },
    },
  ]) {
    // Un-symlink these as they can't be shared due to different
    // experimental triggers config
    const toCopy = fs.readdirSync(path.dirname(file));
    fs.removeSync(path.dirname(file));
    fs.mkdirSync(path.dirname(file), { recursive: true });

    for (const item of toCopy) {
      fs.copySync(
        path.join(
          path.dirname(file).replace(/\.func$/, ''),
          '__data.json.func',
          item
        ),
        path.join(path.dirname(file), item)
      );
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
  }
});

export { workflowPlugin } from './plugin.js';
