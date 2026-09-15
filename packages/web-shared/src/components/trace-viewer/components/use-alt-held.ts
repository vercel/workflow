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
 * Whether Alt/Option is held, for the timeline delta overlay.
 *
 * preventDefault stops Chrome from taking the menu bar (which kills hover).
 * Capture-phase keys; pointermove recovers if keydown was missed; blur
 * clears after Alt+Tab.
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
