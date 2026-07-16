'use client';

import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Kbd } from '../../ui/kbd';
import styles from './trace-shortcut-helper.module.css';

const DISMISSALS_KEY = 'workflow-step-shortcut-helper-dismissals';
const DISMISSAL_LIMIT = 3;
const HINT_ROTATION_MS = 8000;

function getAltKeyLabel(): 'Alt' | 'Option' {
  if (typeof navigator === 'undefined') return 'Alt';
  return navigator.platform.toLowerCase().includes('mac') ? 'Option' : 'Alt';
}

function readDismissals(): number {
  try {
    const dismissals = Number.parseInt(
      window.localStorage.getItem(DISMISSALS_KEY) ?? '0',
      10
    );
    return Number.isNaN(dismissals) ? 0 : dismissals;
  } catch {
    return 0;
  }
}

function AltHint() {
  return (
    <>
      Hold
      <Kbd variant="outline" size="compact" className="mx-1">
        {getAltKeyLabel()}
      </Kbd>
      to see delta between spans
    </>
  );
}

function NavHint() {
  return (
    <>
      Use
      <Kbd variant="outline" size="compact" className="ml-1">
        J
      </Kbd>
      <span className="mx-1">/</span>
      <Kbd variant="outline" size="compact" className="mr-1">
        K
      </Kbd>
      to move between spans
    </>
  );
}

export function TraceShortcutHelper({
  hasMultipleSpans,
  reducedMotion,
}: {
  hasMultipleSpans: boolean;
  reducedMotion: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setVisible(readDismissals() < DISMISSAL_LIMIT);
  }, []);

  useEffect(() => {
    if (reducedMotion) return;
    const id = setInterval(() => {
      setIndex((i) => (i === 0 ? 1 : 0));
    }, HINT_ROTATION_MS);
    return () => clearInterval(id);
  }, [reducedMotion]);

  if (!visible || !hasMultipleSpans) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSALS_KEY, String(readDismissals() + 1));
    } catch {}
    setVisible(false);
  };

  return (
    <div className="group pointer-events-auto hidden h-8 w-fit items-center gap-1 text-xs leading-none text-gray-900 @min-[480px]:flex">
      <span
        aria-live="polite"
        aria-atomic="true"
        className="inline-flex items-center whitespace-nowrap"
      >
        {reducedMotion ? (
          <AltHint />
        ) : (
          <span
            key={index}
            className={`inline-flex items-center ${styles.hint}`}
          >
            {index === 0 ? <AltHint /> : <NavHint />}
          </span>
        )}
      </span>
      <button
        type="button"
        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
        onClick={dismiss}
        aria-label="Dismiss trace shortcuts helper"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
