// CommonJS wrapper for dual SDK/TypeScript plugin functionality
// Allows workflow to work as both:
// 1. An SDK: import { ... } from 'workflow'
// 2. A TypeScript Language Service plugin

import { createRequire } from 'node:module';
const requireFromHere = createRequire(__filename);

//const sdk = requireFromHere('./index.js');

function createTSPlugin(options: any): any {
  console.log('createTSPlugin', options);
  // The package is being used as a TypeScript Language Service plugin
  if (
    options &&
    'typescript' in options &&
    typeof options.typescript === 'object'
  ) {
    const pluginInit = requireFromHere('@workflow/typescript-plugin');
    console.log('pluginInit', pluginInit);
    return pluginInit(options);
  }

  // Not being used as a TS plugin
  throw new Error(
    'workflow should be imported using named exports, not called as a function.\nUse: import { ... } from "workflow"'
  );
}

// Export all named exports from the SDK
//Object.keys(sdk).forEach((key) => {
//  (createTSPlugin as any)[key] = sdk[key];
//});

module.exports = createTSPlugin;
