export const detectScrollbarWidth = (): number => {
  if (!('document' in globalThis)) return 0;
  const size = 400;
  const container = document.createElement('div');
  container.style.width = `${size}px`;
  container.style.height = `${size}px`;
  container.style.overflow = 'scroll';
  document.body.appendChild(container);
  const scrollbarWidth = size - container.scrollWidth;
  container.remove();

  return scrollbarWidth;
};
