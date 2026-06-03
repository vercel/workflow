import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger, setJsonMode } from '../config/log.js';
import { createDeprecationReporter } from './setup.js';

describe('createDeprecationReporter', () => {
  afterEach(() => {
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  it('warns once with replacement and lifecycle guidance', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const report = createDeprecationReporter();
    const notice = {
      endpoint: '/v2/events',
      state: 'deprecated' as const,
      deprecationDate: '2026-03-01',
      sunsetDate: '2026-09-01',
      preferredEndpoint: '/api/v3/runs/[runId]/events',
      documentationUrl: 'https://example.com/migrate',
    };

    report(notice);
    report(notice);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('/v2/events');
    expect(warn.mock.calls[0][0]).toContain('/api/v3/runs/[runId]/events');
    expect(warn.mock.calls[0][0]).toContain('2026-09-01');
    expect(warn.mock.calls[0][0]).toContain('Update workflow');
  });

  it('routes warnings to stderr in JSON mode', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(true);

    createDeprecationReporter()({
      endpoint: '/v2/events',
      state: 'deprecated',
    });

    expect(stderr).toHaveBeenCalledTimes(1);
  });
});
