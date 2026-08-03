import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ErrorStackBlock,
  isStructuredError,
  isStructuredErrorWithStack,
} from '../src/components/ui/error-stack-block.js';

describe('ErrorStackBlock', () => {
  it('recognizes persisted message-only errors as structured errors', () => {
    const error = {
      message: 'Workflow replay exceeded maximum duration after 4 attempts',
    };

    expect(isStructuredError(error)).toBe(true);
    expect(isStructuredErrorWithStack(error)).toBe(false);
  });

  it('renders message-only errors with the error block', () => {
    const markup = renderToStaticMarkup(
      createElement(ErrorStackBlock, {
        value: {
          message: 'Workflow replay exceeded maximum duration after 4 attempts',
        },
      })
    );

    expect(markup).toContain('Copy error');
    expect(markup).toContain(
      'Workflow replay exceeded maximum duration after 4 attempts'
    );
    expect(markup).toContain('var(--ds-red-100)');
  });

  it('ignores non-string stack values on message-only errors', () => {
    const markup = renderToStaticMarkup(
      createElement(ErrorStackBlock, {
        value: {
          message: 'Workflow replay exceeded maximum duration after 4 attempts',
          stack: 123,
        },
      })
    );

    expect(markup).toContain(
      'Workflow replay exceeded maximum duration after 4 attempts'
    );
    expect(markup).not.toContain('123');
  });
});
