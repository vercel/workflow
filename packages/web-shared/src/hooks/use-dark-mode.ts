'use client';

import { useEffect, useState } from 'react';

/**
 * Hook that detects if dark mode is active and reacts to theme changes.
 * Observes the 'dark' class on the document element, which is how
 * next-themes and similar libraries apply the theme.
 *
 * @returns `true` if dark mode is active, `false` otherwise
 */
export const useDarkMode = (): boolean => {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.classList.contains('dark');
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  return isDark;
};
