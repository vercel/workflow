// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StreamImagePreview } from './stream-image-preview';

const png = () =>
  Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64'
    )
  );
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi
      .fn()
      .mockReturnValueOnce('blob:first')
      .mockReturnValue('blob:second'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('previews and downloads the original bytes, releasing URLs when replaced or unmounted', async () => {
  const first = png();
  await act(() =>
    root.render(createElement(StreamImagePreview, { data: first }))
  );
  expect(container.querySelector('img')?.getAttribute('src')).toBe(
    'blob:first'
  );
  expect(container.querySelector('a')?.download).toBe('workflow-stream.png');
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
  expect(blob.type).toBe('image/png');
  expect(blob.size).toBe(first.length);
  await act(() =>
    root.render(createElement(StreamImagePreview, { data: png() }))
  );
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
  expect(container.querySelector('img')?.getAttribute('src')).toBe(
    'blob:second'
  );
  await act(() => root.unmount());
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second');
});

it('keeps the download available if the image cannot be decoded', async () => {
  await act(() =>
    root.render(createElement(StreamImagePreview, { data: png() }))
  );
  await act(() =>
    container.querySelector('img')?.dispatchEvent(new Event('error'))
  );
  expect(container.querySelector('output')?.textContent).toContain(
    'can’t be previewed'
  );
  expect(container.querySelector('a')?.getAttribute('href')).toBe('blob:first');
});
