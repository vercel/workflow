import type { MigrationFramework } from '../framework.js';
import { renderMarkdown } from './report.js';
import {
  collectActivities,
  type TemporalContext,
  transformTemporalFile,
} from './transform.js';

/** `workflow migrate temporal` */
export const temporalFramework: MigrationFramework<TemporalContext> = {
  id: 'temporal',
  label: 'Temporal',
  mightUse: (text) => text.includes('@temporalio/'),
  prepare: collectActivities,
  // Activities modules usually import nothing from Temporal.
  extraFiles: (context) => [...context.activities.keys()],
  transform: (options) => transformTemporalFile(options),
  renderMarkdown,
  boundaryHint:
    'Pass --report <file> for a Markdown report with the start(), resumeHook() and getRun() calls that replace your Temporal client calls.',
};
