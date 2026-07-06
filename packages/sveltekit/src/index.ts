import path from 'node:path';
import {
  joinWorkflowBasePath,
  QUEUE_DELIVERY_HEADERS_GUARD_CODE,
  WORKFLOW_QUEUE_TRIGGER,
  WORKFLOW_ROUTE_BASE,
} from '@workflow/builders';
import fs from 'fs-extra';

import { SvelteKitBuilder } from './builder.js';
import { loadSvelteKitBasePath } from './config.js';
import { stripWorkflowQueueTriggers } from './vc-config.js';

const basePath = await loadSvelteKitBasePath();
const builder = new SvelteKitBuilder({ basePath });

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
  // Note: the adapter emits this function at the root-relative path even
  // when `kit.paths.base` is set (functions are keyed by route id, not
  // public URL), so no base-prefixed variant is needed here.
  for (const { file, config } of [
    {
      file: '.vercel/output/functions/.well-known/workflow/v1/flow.func/.vc-config.json',
      config: {
        maxDuration: 'max',
        experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
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

    // Vercel's queue infrastructure doesn't know about the framework base
    // path: triggers invoke this function at its function-directory path
    // (the root-relative route id), while the SvelteKit server inside is
    // mounted below `kit.paths.base` and 404s that path — so deliveries
    // would retry forever and runs would stay pending. Wrap the handler to
    // move queue deliveries onto the base-prefixed route. Plain HTTP
    // requests are left untouched, so root-relative URLs keep 404ing.
    if (basePath) {
      const vcConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
      const handler = vcConfig.handler as string;
      const wrapperHandler = path.join(
        path.dirname(handler),
        'workflow-flow-entry.mjs'
      );
      fs.writeFileSync(
        path.join(funcDir, wrapperHandler),
        createQueueDeliveryEntryCode(path.basename(handler), basePath)
      );
      fs.writeFileSync(
        file,
        JSON.stringify({ ...vcConfig, handler: wrapperHandler })
      );
    }
  }
});

function createQueueDeliveryEntryCode(
  handlerFile: string,
  basePath: string
): string {
  const flowPath = `${WORKFLOW_ROUTE_BASE}/flow`;
  return `import server from './${handlerFile}';

const isQueueDelivery = ${QUEUE_DELIVERY_HEADERS_GUARD_CODE};

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (
      url.pathname === ${JSON.stringify(flowPath)} &&
      isQueueDelivery(request.headers)
    ) {
      url.pathname = ${JSON.stringify(joinWorkflowBasePath(basePath, flowPath))};
      request = new Request(url, request);
    }
    return server.fetch(request);
  },
};
`;
}

export { workflowPlugin } from './plugin.js';
