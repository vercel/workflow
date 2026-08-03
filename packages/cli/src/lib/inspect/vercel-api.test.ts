import { describe, expect, it } from 'vitest';
import { getVercelDashboardUrl } from './vercel-api.js';

describe('getVercelDashboardUrl', () => {
  it('builds a run deep link with the default (production) environment', () => {
    expect(
      getVercelDashboardUrl('my-team', 'my-project', 'run', 'wrun_123')
    ).toBe(
      'https://vercel.com/my-team/my-project/workflows/runs/wrun_123?environment=production'
    );
  });

  it('respects the preview environment', () => {
    expect(
      getVercelDashboardUrl(
        'my-team',
        'my-project',
        'run',
        'wrun_123',
        'preview'
      )
    ).toBe(
      'https://vercel.com/my-team/my-project/workflows/runs/wrun_123?environment=preview'
    );
  });

  it('never emits the legacy /observability segment', () => {
    const url = getVercelDashboardUrl(
      'my-team',
      'my-project',
      'run',
      'wrun_123',
      'preview'
    );
    expect(url).not.toContain('/observability');
  });

  it('builds an overview link when no id is provided', () => {
    expect(getVercelDashboardUrl('my-team', 'my-project', 'run')).toBe(
      'https://vercel.com/my-team/my-project/workflows?environment=production'
    );
  });

  it('builds a resource-query link for non-run resources', () => {
    expect(
      getVercelDashboardUrl(
        'my-team',
        'my-project',
        'step',
        'step_456',
        'preview'
      )
    ).toBe(
      'https://vercel.com/my-team/my-project/workflows?stepId=step_456&environment=preview'
    );
  });
});
