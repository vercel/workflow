'use client';

import { ChevronDown, ChevronUp, X } from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from 'react';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import {
  clampPanelWidth,
  computeMaxPanelWidth,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  readStoredPanelWidth,
  writeStoredPanelWidth,
} from './detail-panel-width';
import { DraggableBorder } from './draggable-border';
import { useElementWidth } from './use-element-width';

/**
 * The right-hand details aside shared by the Trace and Events tabs: resizable
 * left border with the persisted width model (see detail-panel-width.ts), a
 * header with the title, prev/next (J/K) and close, and a scrolling body.
 * Owners handle selection and keyboard navigation; this is layout only.
 */
export function DetailPanelShell({
  id,
  containerRef,
  title,
  headerActions,
  itemLabel,
  onPrev,
  onNext,
  onClose,
  children,
}: {
  id: string;
  /** The element the panel shares width with; bounds the maximum width. */
  containerRef: RefObject<HTMLElement | null>;
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
  const [storedWidth, setStoredWidth] = useState<number>(() =>
    readStoredPanelWidth()
  );
  const containerWidth = useElementWidth(containerRef);
  const asideRef = useRef<HTMLElement | null>(null);

  const handleResize = useCallback(
    (next: number) => {
      const clamped = clampPanelWidth(next, containerWidth);
      setStoredWidth(clamped);
      writeStoredPanelWidth(clamped);
    },
    [containerWidth]
  );

  const panelWidth = clampPanelWidth(storedWidth, containerWidth);
  const panelMaxWidth = Math.max(
    PANEL_MIN_WIDTH,
    computeMaxPanelWidth(containerWidth)
  );

  return (
    <aside
      ref={asideRef}
      id={id}
      className="relative flex flex-col h-full max-h-full shrink-0 bg-background-100 border-l border-gray-alpha-400"
      style={{ width: panelWidth }}
    >
      <DraggableBorder
        element={asideRef}
        position="left"
        onWidthChange={handleResize}
        onReset={() => handleResize(PANEL_DEFAULT_WIDTH)}
        aria-label={`Resize ${itemLabel} details panel`}
        aria-controls={id}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={panelMaxWidth}
        aria-valuenow={Math.min(
          Math.max(Math.round(panelWidth), PANEL_MIN_WIDTH),
          panelMaxWidth
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
