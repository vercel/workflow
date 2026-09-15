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

/**
 * Rows are ordered by their position in the panel's explicit `attributeOrder`
 * list. Keys missing from that list sorted ahead of every listed key, because
 * `indexOf`'s `-1` miss is truthy and so defeated the `|| 0` fallback meant to
 * catch it — which put a failed step's Error Code above its own name.
 */
describe('AttributePanel row ordering', () => {
  it("keeps a failed step's Error Code below its identity rows", () => {
    const markup = render({
      stepId: 'step_1',
      stepName: 'step//./src/workflows/order//processPayment',
      status: 'failed',
      errorCode: 'USER_ERROR',
    });

    expect(markup).toContain('Error Code');
    expect(markup.indexOf('Error Code')).toBeGreaterThan(
      markup.indexOf('Module')
    );
    expect(markup.indexOf('Error Code')).toBeGreaterThan(
      markup.indexOf('Step ID')
    );
  });

  it('keeps a hook’s classification flags below its token', () => {
    const markup = render({
      hookId: 'hook_1',
      token: 'tok_1',
      isWebhook: true,
      isSystem: false,
    });

    expect(markup.indexOf('isWebhook')).toBeGreaterThan(
      markup.indexOf('Token')
    );
    expect(markup.indexOf('isWebhook')).toBeGreaterThan(
      markup.indexOf('Hook ID')
    );
  });
});
