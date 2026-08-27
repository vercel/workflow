'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Chrome's default Alt handling (menu bar / access keys) blurs the page and
 * suppresses hover until the window is focused again. preventDefault on Alt
 * is how in-app Alt+hover shortcuts (VS Code, Figma) keep hover working after
 * a click.
 */
export function isAltModifierKey(key: string): boolean {
  return key === 'Alt' || key === 'AltGraph';
}

/**
 * True when the event target is a text-entry control, so Option+character
 * compose in the search box is left alone.
 */
export function isTypingTarget(target: unknown): boolean {
  if (target == null || typeof target !== 'object') return false;
  if ('isContentEditable' in target && target.isContentEditable === true) {
    return true;
  }
  if (!('tagName' in target) || typeof target.tagName !== 'string') {
    return false;
  }
  const tag = target.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

export function shouldPreventAltDefault(key: string, target: unknown): boolean {
  return isAltModifierKey(key) && !isTypingTarget(target);
}

export type AltHeldEvent =
  | { kind: 'keydown'; key: string }
  | { kind: 'keyup'; key: string }
  | { kind: 'blur' }
  | { kind: 'pointer'; altKey: boolean };

export function reduceAltHeld(prev: boolean, event: AltHeldEvent): boolean {
  switch (event.kind) {
    case 'keydown':
      return isAltModifierKey(event.key) ? true : prev;
    case 'keyup':
      return isAltModifierKey(event.key) ? false : prev;
    case 'blur':
      return false;
    case 'pointer':
      return event.altKey;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Tracks whether Alt/Option is held for the timeline delta overlay.
 *
 * Listens in the capture phase so a focused detail-panel control cannot
 * swallow the key, prevents Chrome from taking the menu bar (which would
 * kill hover), and can be driven from pointer `altKey` when keydown was
 * missed.
 */
export function useAltHeld(): {
  altHeld: boolean;
  setAltHeldFromPointer: (altKey: boolean) => void;
} {
  const [altHeld, setAltHeld] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isAltModifierKey(e.key)) return;
      if (shouldPreventAltDefault(e.key, e.target)) {
        e.preventDefault();
      }
      setAltHeld((prev) =>
        reduceAltHeld(prev, { kind: 'keydown', key: e.key })
      );
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      setAltHeld((prev) => reduceAltHeld(prev, { kind: 'keyup', key: e.key }));
    };
    const onBlur = (): void => {
      setAltHeld((prev) => reduceAltHeld(prev, { kind: 'blur' }));
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const setAltHeldFromPointer = useCallback((altKey: boolean) => {
    setAltHeld((prev) => reduceAltHeld(prev, { kind: 'pointer', altKey }));
  }, []);

  return { altHeld, setAltHeldFromPointer };
}
