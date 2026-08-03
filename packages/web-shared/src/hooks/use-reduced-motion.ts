'use client';

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Hook that detects whether the user has requested reduced motion and reacts
 * to changes. Mirrors the `prefers-reduced-motion: reduce` media query so
 * components can skip or shorten animations for users with motion
 * sensitivities (e.g. vestibular disorders).
 *
 * @returns `true` if the user prefers reduced motion, `false` otherwise
 */
export const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const media = window.matchMedia(QUERY);
    const onChange = (): void => setReduced(media.matches);

    media.addEventListener('change', onChange);
    onChange();

    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
};
