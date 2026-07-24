import path from 'node:path';
import { getWorkflowQueueTrigger } from '@workflow/builders';
import fs from 'fs-extra';

import { loadSvelteKitConfig, SvelteKitBuilder } from './builder.js';
import { stripWorkflowQueueTriggers } from './vc-config.js';

const { basePath, routesDir } = await loadSvelteKitConfig(process.cwd());
const builder = new SvelteKitBuilder({ basePath, routesDir });

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
    const adapterFuncDir = path.dirname(file);
    if (!fs.existsSync(adapterFuncDir)) {
      continue;
    }
    // The adapter emits this function at the root-relative route id even
    // when `kit.paths.base` is set, but Vercel queue triggers invoke a
    // function at its function-directory path — which the SvelteKit server
    // inside (mounted below the base path) would 404. Recreate the function
    // below the base path so the invocation path matches the mounted route.
    const funcDir = path.join(
      '.vercel/output/functions',
      basePath.slice(1),
      '.well-known/workflow/v1/flow.func'
    );
    const vcConfigFile = path.join(funcDir, '.vc-config.json');

    // Un-symlink these as they can't be shared due to different
    // experimental triggers config
    const sourceFuncDir = path.join(
      adapterFuncDir.replace(/\.func$/, ''),
      '__data.json.func'
    );
    const toCopy = fs.readdirSync(adapterFuncDir);
    fs.removeSync(adapterFuncDir);
    fs.removeSync(funcDir);
    fs.mkdirSync(funcDir, { recursive: true });

    for (const item of toCopy) {
      fs.copySync(path.join(sourceFuncDir, item), path.join(funcDir, item));
    }

    // Update .vc-config.json with the new experimental triggers config
    const existingConfig = JSON.parse(fs.readFileSync(vcConfigFile, 'utf8'));
    fs.writeFileSync(
      vcConfigFile,
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
