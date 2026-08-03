import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttributePanel } from '../src/components/sidebar/attribute-panel.js';

const render = (data: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(AttributePanel, { data }));

/**
 * `vercelId` is the key the analytics read contract stores a flow-function
 * invocation's request id under (the SDK sends it as `requestId`). The panel
 * surfaces it as "Request ID" to match what Vercel Logs calls the value, since
 * this panel's View Logs button is where a reader takes it next.
 */
describe('AttributePanel request id', () => {
  it('renders vercelId as a copyable "Request ID" row', () => {
    const markup = render({
      stepId: 'step_1',
      vercelId: 'iad1::abc-123-def',
    });

    expect(markup).toContain('Request ID');
    expect(markup).toContain('iad1::abc-123-def');
    // Copy affordance, matching the other opaque ids in this section.
    expect(markup).toContain('aria-label="Copy Request ID"');
  });

  it('places Request ID above the coarser Compute Instance ID', () => {
    const markup = render({
      stepId: 'step_1',
      deploymentId: 'dpl_1',
      computeInstanceId: 'cinst_01JQ',
      vercelId: 'iad1::abc-123-def',
    });

    expect(markup.indexOf('Request ID')).toBeGreaterThan(
      markup.indexOf('Deployment ID')
    );
    expect(markup.indexOf('Request ID')).toBeLessThan(
      markup.indexOf('Compute Instance ID')
    );
  });

  /**
   * The analytics schemas type both provenance ids as nullable, and the panel
   * only drops a row whose display fn returns `null` — so stringifying an
   * absent value would render the literal text "null" beside the label.
   */
  it('omits provenance rows whose analytics value is null', () => {
    const markup = render({
      stepId: 'step_1',
      vercelId: null,
      computeInstanceId: null,
    });

    expect(markup).not.toContain('Request ID');
    expect(markup).not.toContain('Compute Instance ID');
    expect(markup).toContain('step_1');
  });
});
