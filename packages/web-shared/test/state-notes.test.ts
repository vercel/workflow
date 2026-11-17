import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StreamViewer } from '../src/components/stream-viewer.js';
import { ExpiredDataNote } from '../src/components/ui/data-state-notes.js';
import { ErrorCard } from '../src/components/ui/error-card.js';
import { Note, NoteAction, NoteContent } from '../src/components/ui/note.js';

/**
 * The error, expired and encrypted states all render through the shared
 * `Note` primitive, so they share one set of tokens and one structure.
 */
describe('Note', () => {
  it('maps each variant to its design tokens without inline styles', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Note,
        { variant: 'error' },
        createElement(NoteContent, null, 'Something went wrong.')
      )
    );

    expect(markup).toContain('role="note"');
    expect(markup).toContain('border-red-400');
    expect(markup).toContain('text-red-900');
    expect(markup).not.toContain('style=');
    // The variant's default icon is rendered.
    expect(markup).toContain('data-slot="note-icon"');
  });

  it('uses the filled background when fill is set', () => {
    const markup = renderToStaticMarkup(
      createElement(Note, { variant: 'warning', fill: true }, 'Heads up')
    );

    expect(markup).toContain('bg-amber-200');
    expect(markup).toContain('border-amber-100');
  });

  it('renders no icon for icon={null} and keeps actions outside the body', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Note,
        { icon: null },
        createElement(NoteContent, null, 'Body'),
        createElement(NoteAction, null, 'Act')
      )
    );

    expect(markup).not.toContain('data-slot="note-icon"');
    const bodyEnd = markup.indexOf('Body');
    const actionStart = markup.indexOf('data-slot="note-action"');
    expect(actionStart).toBeGreaterThan(bodyEnd);
    // The action is a sibling of the body group, not nested in it.
    expect(markup.match(/data-slot="note-body"/g)).toHaveLength(1);
  });
});

describe('ExpiredDataNote', () => {
  it('renders the shared expired copy, overridable per site', () => {
    expect(renderToStaticMarkup(createElement(ExpiredDataNote))).toContain(
      'This data has expired and is no longer available.'
    );
    expect(
      renderToStaticMarkup(
        createElement(ExpiredDataNote, null, 'The run data expired.')
      )
    ).toContain('The run data expired.');
  });
});

describe('ErrorCard', () => {
  it('shows the title and keeps details behind a collapsed disclosure', () => {
    const markup = renderToStaticMarkup(
      createElement(ErrorCard, {
        title: 'Failed to load event data',
        details: 'HTTP 500',
      })
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Failed to load event data');
    // A native <details>/<summary> disclosure, which browsers expose as an
    // expandable control, starting collapsed.
    expect(markup).toMatch(/<details[^>]*data-state="closed"/);
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    expect(markup).toContain('<summary');
    expect(markup).toContain('HTTP 500');
    expect(markup).not.toContain('style=');
  });
});

describe('StreamViewer error', () => {
  it('shows the error above the chunks already received', () => {
    const markup = renderToStaticMarkup(
      createElement(StreamViewer, {
        streamId: 'strm_1',
        chunks: [{ id: 0, value: 'hello' }],
        isLive: false,
        error: 'connection reset',
      })
    );

    expect(markup).toContain('Error reading stream:');
    expect(markup).toContain('connection reset');
    // The chunk list is still mounted under the error.
    expect(markup).toContain('data-virtuoso-scroller');
    expect(markup.indexOf('connection reset')).toBeLessThan(
      markup.indexOf('data-virtuoso-scroller')
    );
  });

  it('does not claim the stream is empty when nothing arrived before the error', () => {
    const markup = renderToStaticMarkup(
      createElement(StreamViewer, {
        streamId: 'strm_1',
        chunks: [],
        isLive: false,
        error: 'connection reset',
      })
    );

    expect(markup).toContain('connection reset');
    expect(markup).not.toContain('Stream is empty');
  });
});
