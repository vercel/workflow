import fs from 'node:fs/promises';
import { LocalBuilder } from './builders.js';

const localBuilder = new LocalBuilder({});

// This needs to be in the top-level as we need to create these
// entries before svelte plugin is started or the entries are
// a race to be created before svelte discovers entries
await localBuilder.build();

export function workflowPlugin() {
  return {
    name: 'workflow-sveltekit-plugin',
    async writeBundle() {
      // don't attempt patching functions output if not Vercel adapter
      if (!process.env.VERCEL_DEPLOYMENT_ID) {
        return;
      }

      for (const { file, config } of [
        {
          file: '.vercel/output/functions/.well-known/workflow/v1/flow.func/.vc-config.json',
          config: {
            experimentalTriggers: [
              {
                type: 'queue/v1beta',
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
                type: 'queue/v1beta',
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
        const existingConfig = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.writeFile(
          file,
          JSON.stringify({
            ...existingConfig,
            config,
          })
        );
      }
    },
  };
}

export { workflowRollupPlugin } from 'workflow/rollup-plugin';
