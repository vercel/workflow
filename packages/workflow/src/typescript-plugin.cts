// TypeScript server does `require(pluginName)` to load plugins,
// so we need to export the plugin as a CommonJS module
import typescriptPlugin = require('@workflow/typescript-plugin');
export = typescriptPlugin;
