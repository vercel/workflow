'use client';

import { useEffect, useState } from 'react';

function isAltModifierKey(key: string): boolean {
  return key === 'Alt' || key === 'AltGraph';
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * Tracks whether Alt/Option is held for the timeline delta overlay.
 *
 * Chrome's default Alt handling (menu bar / access keys) blurs the page and
 * suppresses hover until the window is focused again. preventDefault on Alt
 * is how in-app Alt+hover shortcuts (VS Code, Figma) keep hover working after
 * a click. Listeners run in the capture phase so a focused detail-panel
 * control cannot swallow the key. Window pointermove recovers if keydown was
 * missed; blur still clears the flag so the overlay cannot stick after Alt+Tab.
 */
export function useAltHeld(): { altHeld: boolean } {
  const [altHeld, setAltHeld] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isAltModifierKey(e.key)) return;
      if (!isTypingTarget(e.target)) {
        e.preventDefault();
      }
      setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (isAltModifierKey(e.key)) setAltHeld(false);
    };
    const onBlur = (): void => setAltHeld(false);
    const onPointerMove = (e: PointerEvent): void => setAltHeld(e.altKey);

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointermove', onPointerMove, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointermove', onPointerMove, true);
    };
  }, []);

  return { altHeld };
}
