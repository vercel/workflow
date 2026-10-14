import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RunLimitGuidanceAlert } from './run-limit-guidance-alert';

afterEach(cleanup);

describe('RunLimitGuidanceAlert', () => {
  it('recommends QuickJS for a node run that hit the event limit', () => {
    render(
      <RunLimitGuidanceAlert
        run={{ status: 'failed', errorCode: 'MAX_EVENTS_EXCEEDED' }}
      />
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'WORKFLOW_VM=quickjs'
    );
    expect(
      screen.getByRole('link', { name: 'Learn more' }).getAttribute('href')
    ).toBe('https://workflow-sdk.dev/err/max-events-exceeded');
  });

  it('renders nothing for runs already on QuickJS with snapshotting', () => {
    const { container } = render(
      <RunLimitGuidanceAlert
        run={{
          status: 'failed',
          errorCode: 'MAX_EVENTS_EXCEEDED',
          workflowVm: 'quickjs',
          snapshotThreshold: 1000,
        }}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for other failures', () => {
    const { container } = render(
      <RunLimitGuidanceAlert
        run={{ status: 'failed', errorCode: 'USER_ERROR' }}
      />
    );
    expect(container.innerHTML).toBe('');
  });
});
