import { LocalBuilder } from './builders';
import { workflowPlugin } from './plugin';

// Build the workflows
await new LocalBuilder().build();

// Registers the plugin with Bun runtime
Bun.plugin(workflowPlugin());
