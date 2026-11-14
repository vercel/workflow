'use client';

import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH } from './detail-panel-width';
import { DraggableBorder } from './draggable-border';
import { isTypingTarget } from './use-alt-held';
import type { DetailPanelWidth } from './use-detail-panel-width';

/**
 * The right-hand details aside shared by the Trace and Events tabs: resizable
 * left border, a header with the title, prev/next and close, and a scrolling
 * body. While mounted it handles the shortcuts its header advertises (K or
 * ArrowUp, J or ArrowDown, Escape) anywhere on the page, so mount it only
 * while an item is selected. The width lives with the owner
 * (`useDetailPanelWidth`), which stays mounted while the panel comes and goes.
 */
export function DetailPanelShell({
  id,
  width,
  title,
  headerActions,
  itemLabel,
  onPrev,
  onNext,
  onClose,
  children,
}: {
  id: string;
  width: DetailPanelWidth;
  title: ReactNode;
  /** Extra header controls, rendered before prev/next. */
  headerActions?: ReactNode;
  /** What one item is called in labels, e.g. "span" or "event". */
  itemLabel: string;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const asideRef = useRef<HTMLElement | null>(null);

  // Read through a ref so the listener is registered once, whatever the
  // identity of the callbacks the owner passes on each render.
  const handlersRef = useRef({ onPrev, onNext, onClose });
  handlersRef.current = { onPrev, onNext, onClose };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Leave keys typed into a field, and presses another handler took (a
      // tree row moving focus, a search box clearing itself).
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const handlers = handlersRef.current;
      let handler: (() => void) | undefined;
      if (e.key === 'k' || e.key === 'ArrowUp') handler = handlers.onPrev;
      else if (e.key === 'j' || e.key === 'ArrowDown')
        handler = handlers.onNext;
      else if (e.key === 'Escape') handler = handlers.onClose;
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <aside
      ref={asideRef}
      id={id}
      className="relative flex flex-col h-full max-h-full shrink-0 bg-background-100 border-l border-gray-alpha-400"
      style={{ width: width.width }}
    >
      <DraggableBorder
        element={asideRef}
        position="left"
        onWidthChange={width.resize}
        onReset={() => width.resize(PANEL_DEFAULT_WIDTH)}
        aria-label={`Resize ${itemLabel} details panel`}
        aria-controls={id}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={width.maxWidth}
        aria-valuenow={Math.min(
          Math.max(Math.round(width.width), PANEL_MIN_WIDTH),
          width.maxWidth
        )}
      />
      {/* Panel header */}
      <div className="flex items-center justify-between gap-2 shrink-0 px-4 py-[7.5px]">
        <div className="flex min-w-0 items-center gap-2 text-label-14 font-medium text-gray-1000">
          {title}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {headerActions}
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="Navigate up"
                aria-keyshortcuts="K"
                onClick={onPrev}
                disabled={!onPrev}
              >
                <ChevronUp className="w-4 h-4" />
              </IconButton>
            </TooltipTrigger>
            {onPrev ? (
              <TooltipContent>
                Navigate up
                <Kbd>K</Kbd>
              </TooltipContent>
            ) : null}
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="Navigate down"
                aria-keyshortcuts="J"
                onClick={onNext}
                disabled={!onNext}
              >
                <ChevronDown className="w-4 h-4" />
              </IconButton>
            </TooltipTrigger>
            {onNext ? (
              <TooltipContent>
                Navigate down
                <Kbd>J</Kbd>
              </TooltipContent>
            ) : null}
          </Tooltip>
          <div aria-hidden className="w-px h-4 bg-gray-alpha-400 mx-1" />
          <IconButton
            aria-label={`Close ${itemLabel} details`}
            aria-keyshortcuts="Escape"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>
      </div>
      {/* Panel body */}
      <div className="flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}
