import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/utils', () => ({
  cn: (...inputs: Array<string | undefined>) =>
    inputs.filter(Boolean).join(' '),
}));

import { DocsLink } from './docs-link';

describe('DocsLink', () => {
  it('renders an external anchor for absolute docs URLs', () => {
    render(
      <DocsLink href="https://useworkflow.dev/docs/foundations/hooks">
        Learn how to create a hook
      </DocsLink>
    );

    const link = screen.getByRole('link', {
      name: 'Learn how to create a hook',
    });

    expect(link.getAttribute('href')).toBe(
      'https://useworkflow.dev/docs/foundations/hooks'
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
