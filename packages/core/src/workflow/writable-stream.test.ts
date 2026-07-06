import { afterEach, describe, expect, it } from 'vitest';
import {
  STREAM_FRAMING_SYMBOL,
  STREAM_NAME_SYMBOL,
  WORKFLOW_DEFAULT_STREAM_FRAMING,
  WORKFLOW_GET_STREAM_ID,
} from '../symbols.js';
import { getWritable } from './writable-stream.js';

// The workflow VM installs these globals host-side (see workflow.ts); the
// tests stand in for that setup.
const g = globalThis as Record<symbol, unknown>;

describe('workflow-context getWritable', () => {
  afterEach(() => {
    delete g[WORKFLOW_GET_STREAM_ID];
    delete g[WORKFLOW_DEFAULT_STREAM_FRAMING];
  });

  it('tags handles with the run framing from the VM global (framed-v2)', () => {
    g[WORKFLOW_GET_STREAM_ID] = () => 'strm_default';
    g[WORKFLOW_DEFAULT_STREAM_FRAMING] = 'framed-v2';

    const writable = getWritable() as unknown as Record<symbol, unknown>;
    expect(writable[STREAM_NAME_SYMBOL]).toBe('strm_default');
    // Without the tag, a step or external client reviving this handle would
    // write framed-v1 while Run.getReadable (which derives framing from the
    // run's SDK version) strips a marker that isn't there — corrupting every
    // frame. Regression: world-testing's hooks e2e hung exactly this way.
    expect(writable[STREAM_FRAMING_SYMBOL]).toBe('framed-v2');
  });

  it('leaves handles untagged when the run predates framed-v2', () => {
    g[WORKFLOW_GET_STREAM_ID] = () => 'strm_default';
    g[WORKFLOW_DEFAULT_STREAM_FRAMING] = undefined;

    const writable = getWritable() as unknown as Record<symbol, unknown>;
    expect(writable[STREAM_NAME_SYMBOL]).toBe('strm_default');
    expect(writable[STREAM_FRAMING_SYMBOL]).toBeUndefined();
  });
});
