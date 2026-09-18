import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttributeBlock } from './attribute-panel';

describe('AttributeBlock cancellation reason', () => {
  it('shows a recorded cancellation reason', () => {
    const html = renderToStaticMarkup(
      <AttributeBlock
        attribute="cancelReason"
        value="Manually canceled from the dashboard."
      />
    );

    expect(html).toContain('Cancellation');
    expect(html).toContain('Manually canceled from the dashboard.');
  });

  it('shows a fallback when no reason was recorded', () => {
    const html = renderToStaticMarkup(
      <AttributeBlock attribute="cancelReason" value={null} />
    );

    expect(html).toContain('Cancellation');
    expect(html).toContain('No reason was provided.');
  });
});
