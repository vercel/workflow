import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeprecationNoticeProvider,
  publishWorkflowBackendDeprecations,
  WorkflowBackendDeprecationAlerts,
} from './deprecation-context';

describe('WorkflowBackendDeprecationAlerts', () => {
  afterEach(cleanup);

  it('renders and deduplicates endpoint lifecycle notices', () => {
    render(
      <DeprecationNoticeProvider>
        <WorkflowBackendDeprecationAlerts />
      </DeprecationNoticeProvider>
    );

    const notice = {
      endpoint: '/v2/events',
      state: 'deprecated' as const,
      deprecationDate: '2026-03-01',
      sunsetDate: '2026-09-01',
      preferredEndpoint: '/api/v3/runs/[runId]/events',
      documentationUrl: 'https://example.com/migrate',
    };
    act(() => publishWorkflowBackendDeprecations([notice, notice]));

    expect(
      screen.getAllByText('Workflow backend endpoint deprecated')
    ).toHaveLength(1);
    expect(screen.getByText('/v2/events')).toBeDefined();
    expect(screen.getByText('/api/v3/runs/[runId]/events')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Migration guide' })).toBeDefined();
  });
});
