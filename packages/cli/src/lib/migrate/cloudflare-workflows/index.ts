import type * as TS from 'typescript';
import type { MigrationFramework } from '../framework.js';
import { renderMarkdown } from './report.js';
import {
  type CloudflareContext,
  transformCloudflareWorkflowsFile,
} from './transform.js';
import { readWranglerConfig } from './wrangler.js';

/** The context of the last `prepare()`, for the report. */
let lastContext: CloudflareContext | undefined;

/** `workflow migrate cloudflare-workflows` */
export const cloudflareWorkflowsFramework: MigrationFramework<CloudflareContext> =
  {
    id: 'cloudflare-workflows',
    label: 'Cloudflare Workflows',
    mightUse: (text) =>
      text.includes('WorkflowEntrypoint') ||
      text.includes('cloudflare:workflows') ||
      text.includes('.sendEvent(') ||
      /\.createBatch\(|\.create\(\s*\{/.test(text),
    // The wrangler config says which `this.env` names are vars (readable from
    // process.env) and which are bindings, and which bindings are workflows.
    prepare(_ts: typeof TS, program: TS.Program) {
      lastContext = readWranglerConfig(program.getCurrentDirectory());
      return lastContext;
    },
    transform: (options) => transformCloudflareWorkflowsFile(options),
    renderMarkdown: (reports, failed) =>
      renderMarkdown(reports, failed, lastContext),
    boundaryHint:
      'Pass --report <file> for a Markdown report with a drop-in replacement for your Workflow bindings (env.MY_WORKFLOW).',
  };
