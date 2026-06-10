'use client';

import { Root as SlotRoot, Slottable } from '@radix-ui/react-slot';
import type { JSX, MutableRefObject, ReactNode, RefObject } from 'react';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import useMeasure from 'react-use-measure';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { cn } from '../../lib/utils';

const INACTIVE_TIMEOUT_MS = 250;
const ENTER_DELAY_MS = 0;
const OPEN_DELAY_MS = 150;
const MAX_TRANSITION_DISTANCE_PX = 150;
const MAX_OVERLAP_FOR_TRANSITION_PERCENT = 100;
const PERSIST_TIMEOUT_MS = 1000;

interface Point {
  x: number;
  y: number;
}

interface ContextCardData {
  id: string;
  origin: Point;
  contentSize: { width: number; height: number };
  side: Side;
  arrowOffset: Point;
}

type NullString = string | null;

interface ContextCardContextType {
  rootOrigin: Point;
  rootBounds: { width: number; height: number };
  portalRef: RefObject<HTMLDivElement | null>;
  activeId: RefObject<NullString | null>;
  setActiveId: (id: NullString) => void;
  hoveredId: NullString;
  setHoveredId: (id: NullString) => void;
  updateActiveContextCard: (update: ContextCardData | null) => void;
  skipTransition: boolean;
  rootVisible: boolean;
  distanceFromLast: number;
  lastOrigin: Point | null;
  /** Whether a real {@link ContextCardProvider} is mounted above this consumer. */
  isProvided: boolean;
}

const ContextCardContext = createContext<ContextCardContextType>({
  rootOrigin: { x: 0, y: 0 },
  rootBounds: { width: 0, height: 0 },
  portalRef: null as unknown as RefObject<HTMLDivElement | null>,
  activeId: null as unknown as MutableRefObject<string | null>,
  setActiveId: () => void 0,
  hoveredId: null,
  setHoveredId: () => void 0,
  updateActiveContextCard: () => void 0,
  skipTransition: false,
  rootVisible: false,
  distanceFromLast: 0,
  lastOrigin: null,
  isProvided: false,
});
ContextCardContext.displayName = 'ContextCardContext';

/**
 * Returns whether the current subtree is wrapped in a {@link ContextCardProvider}.
 */
export function useHasContextCardProvider(): boolean {
  return useContext(ContextCardContext).isProvided;
}

function usePrevious<T>(value: T): T | null {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

function isRefObject(
  value: HTMLElement | RefObject<HTMLElement | null> | null | undefined
): value is RefObject<HTMLElement | null> {
  return value !== null && value !== undefined && 'current' in value;
}

/**
 * Provides shared state and a portal container for {@link ContextCardTrigger}
 * components. Must wrap any tree containing triggers; manages positioning,
 * visibility transitions, and the animated arrow tip across all cards.
 */
export function ContextCardProvider({
  children,
  portalTarget,
}: {
  children: ReactNode;
  /** Custom container for the portal. Accepts either an element or a ref. */
  portalTarget?: HTMLElement | RefObject<HTMLElement | null> | null;
}): ReactNode {
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => setIsMounted(true), []);
  const resolvedPortalTarget = isRefObject(portalTarget)
    ? portalTarget.current
    : portalTarget;
  const [ref, bounds] = useMeasure();
  const portalRef = useRef<HTMLDivElement | null>(null);
  const [activeContextCard, setActiveContextCard] =
    useState<ContextCardData | null>(null);
  const [visible, setVisible] = useState(false);
  const [hoveredId, setHoveredId] = useState<NullString>(null);
  const activeId = useRef<NullString>(null);

  function setActiveId(id: NullString): void {
    activeId.current = id;
    setVisible(id !== null);
  }
  const updateActiveContextCard = (update: ContextCardData | null): void => {
    if (update?.id !== activeId.current && update !== null) return;
    setActiveContextCard(update);
  };

  const BORDER_WIDTH = 1;

  const activeBounds = useMemo(() => {
    if (!activeContextCard)
      return {
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        side: 'top' as Side,
        arrowOffset: { x: 0, y: 0 },
      };
    return {
      width: activeContextCard.contentSize.width + BORDER_WIDTH * 2,
      height: activeContextCard.contentSize.height + BORDER_WIDTH * 2,
      x: activeContextCard.origin.x,
      y: activeContextCard.origin.y,
      side: activeContextCard.side,
      arrowOffset: activeContextCard.arrowOffset,
    };
  }, [activeContextCard]);

  const lastBounds = usePrevious(activeBounds);
  const lastId = usePrevious(activeId.current);

  const percentOverlapFromLast = useMemo(() => {
    if (!lastBounds) return 0;

    const overlapLeft = Math.max(activeBounds.x, lastBounds.x);
    const overlapRight = Math.min(
      activeBounds.x + activeBounds.width,
      lastBounds.x + lastBounds.width
    );
    const overlapTop = Math.max(activeBounds.y, lastBounds.y);
    const overlapBottom = Math.min(
      activeBounds.y + activeBounds.height,
      lastBounds.y + lastBounds.height
    );

    if (overlapLeft < overlapRight && overlapTop < overlapBottom) {
      const overlapArea =
        (overlapRight - overlapLeft) * (overlapBottom - overlapTop);

      const activeBoundsArea = activeBounds.width * activeBounds.height;

      if (activeBoundsArea === 0) return 0;

      return (overlapArea / activeBoundsArea) * 100;
    }

    return 0;
  }, [activeBounds, lastBounds]);

  const distanceFromLast = useMemo(
    () =>
      Math.sqrt(
        ((lastBounds?.x ?? 0) - activeBounds.x) ** 2 +
          ((lastBounds?.y ?? 0) - activeBounds.y) ** 2
      ),
    [activeBounds.x, activeBounds.y, lastBounds?.x, lastBounds?.y]
  );

  const lastOrigin = useMemo(() => {
    if (!lastBounds) return null;
    return {
      x: lastBounds.x - activeBounds.x,
      y: lastBounds.y - activeBounds.y,
    };
  }, [activeBounds, lastBounds]);

  const [isScrolling, setIsScrolling] = useState(false);
  const skipTransition = useMemo(
    () =>
      distanceFromLast > MAX_TRANSITION_DISTANCE_PX ||
      percentOverlapFromLast > MAX_OVERLAP_FOR_TRANSITION_PERCENT ||
      lastId === null ||
      isScrolling,
    [distanceFromLast, isScrolling, lastId, percentOverlapFromLast]
  );

  useEffect(() => {
    let isScrollingTimeout: ReturnType<typeof setTimeout> | null = null;

    const onScroll = (): void => {
      if (isScrollingTimeout) window.clearTimeout(isScrollingTimeout);

      isScrollingTimeout = setTimeout(() => {
        setIsScrolling(false);
      }, 66);

      if (!isScrolling) {
        setIsScrolling(true);
      }
    };

    document.addEventListener('scroll', onScroll, true);

    return () => {
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [isScrolling]);

  const contextValue = useMemo(
    () => ({
      updateActiveContextCard,
      rootOrigin: { ...activeBounds },
      rootBounds: bounds,
      portalRef,
      setActiveId,
      activeId,
      setHoveredId,
      hoveredId,
      skipTransition,
      rootVisible: visible,
      distanceFromLast,
      lastOrigin,
      isProvided: true,
    }),
    [
      activeBounds,
      bounds,
      hoveredId,
      skipTransition,
      visible,
      distanceFromLast,
      lastOrigin,
    ]
  );

  return (
    <ContextCardContext.Provider value={contextValue}>
      {children}
      {isMounted
        ? createPortal(
            <div
              className="w-full h-full inset-0 fixed pointer-events-none z-[100000]"
              ref={ref}
            >
              <div
                className="min-w-max transition-all duration-150 ease-[easing-function:cubic-bezier(0.3,_0.57,_0.07,_0.95)] will-change-[transform,width,height] motion-reduce:!transition-none"
                style={{
                  opacity: visible ? 1 : 0,
                }}
              >
                <div
                  className={cn(
                    'absolute bg-background-100 bg-clip-padding rounded-[6px] overflow-visible pointer-events-none z-[1000000] shadow-[var(--ds-shadow-tooltip),0_0_0_1px_var(--ds-background-100)] w-fit [--context-card-tip-stroke:#DBDBDB] dark-theme:[--context-card-tip-stroke:#252525]',
                    skipTransition
                      ? '!transition-none'
                      : 'transition-[transform,width,height] duration-250 ease-[easing-function:cubic-bezier(0.29,0.31,0.05,0.96)] will-change-[transform,width,height] motion-reduce:!transition-none'
                  )}
                  data-skip-transition={skipTransition}
                  style={{
                    transform: `translate(${activeBounds.x}px,${activeBounds.y}px)`,
                    width: activeBounds.width,
                    height: activeBounds.height,
                  }}
                >
                  <div
                    className={cn(
                      'w-[14px] h-[7px] absolute grid place-content-center z-[999999999] origin-center',
                      {
                        'top-full -translate-x-1/2 rotate-0':
                          activeBounds.side === 'top',
                        'right-full -translate-y-1/2 rotate-90 -mr-[3.5px]':
                          activeBounds.side === 'right',
                        'bottom-full -translate-x-1/2 rotate-180':
                          activeBounds.side === 'bottom',
                        'left-full -translate-y-1/2 rotate-[270deg] -ml-[3.5px]':
                          activeBounds.side === 'left',
                      },
                      skipTransition
                        ? '!transition-none'
                        : 'transition-[transform,width,height] duration-250 ease-[easing-function:cubic-bezier(0.29,0.31,0.05,0.96)] will-change-[transform,width,height] motion-reduce:!transition-none'
                    )}
                    style={{
                      ...(activeBounds.side === 'top' ||
                      activeBounds.side === 'bottom'
                        ? {
                            left: `calc(50% + ${activeBounds.arrowOffset.x}px)`,
                          }
                        : {
                            top: `calc(50% + ${activeBounds.arrowOffset.y}px)`,
                          }),
                    }}
                    data-skip-transition={skipTransition}
                    data-side={activeBounds.side}
                  >
                    <svg
                      width="14"
                      height="7"
                      viewBox="0 0 14 7"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden="true"
                    >
                      <g clipPath="url(#context-card-tip-clip)">
                        <path
                          d="M15 -0.5V0.5H12.9834L12.8184 0.508789C12.4377 0.550822 12.0853 0.738056 11.8359 1.03418L8.53027 4.95996C7.73114 5.90893 6.26886 5.90892 5.46973 4.95996L2.16406 1.03418C1.87905 0.695733 1.45907 0.5 1.0166 0.5H-1V-0.5H15Z"
                          fill="var(--ds-background-100)"
                          style={{
                            fill: 'var(--ds-background-100)',
                            fillOpacity: 1,
                            stroke: 'var(--context-card-tip-stroke)',
                            strokeOpacity: 1,
                          }}
                        />
                      </g>
                      <defs>
                        <clipPath id="context-card-tip-clip">
                          <rect
                            width="14"
                            height="7"
                            fill="white"
                            style={{ fill: 'white', fillOpacity: 1 }}
                          />
                        </clipPath>
                      </defs>
                    </svg>
                  </div>
                  <div ref={portalRef} />
                </div>
              </div>
            </div>,
            resolvedPortalTarget ?? document.body
          )
        : null}
    </ContextCardContext.Provider>
  );
}

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';

/** Props for the {@link ContextCardTrigger} component. */
export interface ContextCardTriggerProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'content'> {
  /** The content rendered inside the context card popup. */
  content: ReactNode;
  /** Which side of the trigger to display the card. Defaults to `"right"`. */
  side?: Side;
  /** Alignment of the card relative to the trigger. Defaults to `"center"`. */
  align?: Align;
  /** Distance in pixels between the trigger and the card. Defaults to `16`. */
  sideOffset?: number;
  /** Offset in pixels along the alignment axis. Defaults to `0`. */
  alignOffset?: number;
  /** Whether to disable pointer events on the card content. */
  ignoreCardPointerEvents?: boolean;
  /** Whether to remove default padding from the card content. */
  noPadding?: boolean;
  /** Whether the trigger uses the Slot pattern to merge props onto its child. */
  asChild?: boolean;
  /** Can be used to hide the card when needed. */
  hide?: boolean;
  /** Time in milliseconds before the card is dismissed after mouse leaves. */
  inactiveTimeoutMs?: number;
}

/**
 * Displays a floating context card on hover with viewport-aware collision
 * detection and animated position transitions between triggers in the same
 * {@link ContextCardProvider}. Persists briefly after mouse leave.
 */
export function ContextCardTrigger({
  content,
  children,
  side = 'right',
  align = 'center',
  sideOffset = 16,
  alignOffset = 0,
  ignoreCardPointerEvents = false,
  noPadding,
  asChild,
  className,
  hide,
  inactiveTimeoutMs = INACTIVE_TIMEOUT_MS,
}: ContextCardTriggerProps): JSX.Element {
  const triggerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentMeasureRef, contentMeasureBounds] = useMeasure();
  const {
    portalRef,
    updateActiveContextCard,
    activeId,
    setActiveId,
    hoveredId,
    setHoveredId,
    skipTransition,
    rootVisible,
  } = useContext(ContextCardContext);
  const id = useId();

  useEffect(() => {
    return () => {
      // Only clear the shared active card if this trigger was the active one;
      // otherwise an unmounting inactive trigger would hide another trigger's card.
      if (activeId.current === id) {
        setActiveId(null);
      }
    };
  }, []);

  const reduceMotion = useReducedMotion();

  const [localHover, setLocalHover] = useState(false);
  const [persisting, setPersisting] = useState(false);
  const [visible, setVisible] = useState(false);

  const activeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (
      localHover &&
      contentMeasureBounds.width > 0 &&
      contentMeasureBounds.height > 0
    ) {
      if (openTimeout.current) clearTimeout(openTimeout.current);
      openTimeout.current = setTimeout(
        () => {
          setActiveId(id);
          updateBounds();
        },
        rootVisible ? 0 : OPEN_DELAY_MS
      );
    }
    return () => {
      if (openTimeout.current) clearTimeout(openTimeout.current);
    };
  }, [localHover, contentMeasureBounds]);

  const enterTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (enterTimeout.current) clearTimeout(enterTimeout.current);
    if (hoveredId !== id) {
      // Exits are instant
      setVisible(false);
    } else {
      // Enters can be delayed unless we wish to script the transition
      enterTimeout.current = setTimeout(
        () => {
          setVisible(true);
        },
        reduceMotion || skipTransition ? 0 : ENTER_DELAY_MS
      );
    }
  }, [hoveredId, id, reduceMotion, skipTransition]);

  function updateBounds(): void {
    if (!contentRef.current) return;
    const bounds = computeBounds();
    updateActiveContextCard({ id, ...bounds });
  }

  function computeBounds(sideOverride?: Side): {
    origin: Point;
    contentSize: { width: number; height: number };
    side: Side;
    arrowOffset: Point;
  } {
    if (!triggerRef.current) throw new Error('Trigger not found');
    if (!contentRef.current) throw new Error('Content not found');
    const appliedSide = sideOverride ?? side;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const contentRect = contentRef.current.getBoundingClientRect();
    contentRef.current.style.width = 'max-content';
    contentRef.current.style.position = 'absolute';
    const contentSize = {
      width: Math.max(contentRect.width, contentRef.current.offsetWidth),
      height: contentRect.height,
    };

    let origin: Point;

    const arrowWidth = 14;
    const halfArrowWidth = arrowWidth / 2;
    const halfTriggerWidth = triggerRect.width / 2;
    const halfTriggerHeight = triggerRect.height / 2;
    const halfContentWidth = contentSize.width / 2;
    const halfContentHeight = contentSize.height / 2;

    const top = triggerRect.top;
    const left = triggerRect.left;

    let alignX = left + halfTriggerWidth - halfContentWidth + alignOffset;
    if (align === 'start') alignX = left + alignOffset;
    if (align === 'end')
      alignX = left + triggerRect.width - contentRect.width + alignOffset;

    let alignY = top + halfTriggerHeight - halfContentHeight + alignOffset;
    if (align === 'start') alignY = top + alignOffset;
    if (align === 'end')
      alignY = top + triggerRect.height - contentRect.height + alignOffset;

    switch (appliedSide) {
      case 'top':
        origin = {
          x: alignX,
          y: top - contentRect.height - sideOffset,
        };
        break;
      case 'right':
        origin = {
          x: left + triggerRect.width + sideOffset,
          y: alignY,
        };
        break;
      case 'bottom':
        origin = {
          x: alignX,
          y: top + triggerRect.height + sideOffset,
        };
        break;
      case 'left':
        origin = {
          x: left - contentRect.width - sideOffset,
          y: alignY,
        };
        break;
      default: {
        const _exhaustive: never = appliedSide;
        throw new Error(`Unknown side: ${String(_exhaustive)}`);
      }
    }

    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;

    const isOffscreenLeft = origin.x < 0;
    const isOffscreenRight = origin.x + contentRect.width > viewportWidth;
    const isOffscreenTop = origin.y < 0;
    const isOffscreenBottom = origin.y + contentRect.height > viewportHeight;

    if (!sideOverride) {
      const spaceAbove = top;
      const spaceBelow = viewportHeight - (top + triggerRect.height);
      const spaceLeft = left;
      const spaceRight = viewportWidth - (left + triggerRect.width);

      if (side === 'top' && isOffscreenTop && spaceBelow > spaceAbove) {
        return computeBounds('bottom');
      }
      if (side === 'bottom' && isOffscreenBottom && spaceAbove > spaceBelow) {
        return computeBounds('top');
      }

      if (side === 'right' && isOffscreenRight && spaceLeft > spaceRight) {
        return computeBounds('left');
      }
      if (side === 'left' && isOffscreenLeft && spaceRight > spaceLeft) {
        return computeBounds('right');
      }

      if (
        (side === 'top' || side === 'bottom') &&
        isOffscreenLeft &&
        spaceRight > contentRect.width
      ) {
        return computeBounds('right');
      }
      if (
        (side === 'top' || side === 'bottom') &&
        isOffscreenRight &&
        spaceLeft > contentRect.width
      ) {
        return computeBounds('left');
      }

      if (
        (side === 'left' || side === 'right') &&
        isOffscreenTop &&
        spaceBelow > contentRect.height
      ) {
        return computeBounds('bottom');
      }
      if (
        (side === 'left' || side === 'right') &&
        isOffscreenBottom &&
        spaceAbove > contentRect.height
      ) {
        return computeBounds('top');
      }
    }

    const viewportPadding = 8;
    if (appliedSide === 'left' || appliedSide === 'right') {
      origin.y = Math.max(
        viewportPadding,
        Math.min(
          origin.y,
          viewportHeight - contentSize.height - viewportPadding
        )
      );
    } else {
      origin.x = Math.max(
        viewportPadding,
        Math.min(origin.x, viewportWidth - contentSize.width - viewportPadding)
      );
    }

    // Always constrain Y position within viewport bounds
    origin.y = Math.max(
      viewportPadding,
      Math.min(origin.y, viewportHeight - contentSize.height - viewportPadding)
    );

    const triggerCenterX = left + halfTriggerWidth;
    const triggerCenterY = top + halfTriggerHeight;
    const cardCenterX = origin.x + contentSize.width / 2;
    const cardCenterY = origin.y + contentSize.height / 2;

    let arrowOffsetX = triggerCenterX - cardCenterX;
    let arrowOffsetY = triggerCenterY - cardCenterY;

    // Clamp arrow offset to ensure it stays within card boundaries.
    // Arrow should be at least halfArrowWidth (7px) from the card edges.
    const maxArrowOffsetX = halfContentWidth - halfArrowWidth;
    const maxArrowOffsetY = halfContentHeight - halfArrowWidth;

    if (appliedSide === 'top' || appliedSide === 'bottom') {
      arrowOffsetX = Math.max(
        -maxArrowOffsetX,
        Math.min(arrowOffsetX, maxArrowOffsetX)
      );
    }

    if (appliedSide === 'left' || appliedSide === 'right') {
      arrowOffsetY = Math.max(
        -maxArrowOffsetY,
        Math.min(arrowOffsetY, maxArrowOffsetY)
      );
    }

    const arrowOffset = {
      x: arrowOffsetX,
      y: arrowOffsetY,
    };

    return { origin, contentSize, side: appliedSide, arrowOffset };
  }

  useEffect(() => {
    document.addEventListener('scroll', updateBounds, true);
    window.addEventListener('resize', updateBounds);
    return () => {
      document.removeEventListener('scroll', updateBounds, true);
      window.removeEventListener('resize', updateBounds);
    };
  }, []);

  function resetDestructiveTimeouts(): void {
    if (activeTimeout.current) clearTimeout(activeTimeout.current);
    if (persistingTimeout.current) clearTimeout(persistingTimeout.current);
    if (openTimeout.current) clearTimeout(openTimeout.current);
  }

  function attemptDeactivate(): void {
    if (activeTimeout.current) clearTimeout(activeTimeout.current);
    activeTimeout.current = setTimeout(() => {
      if (activeId.current !== id) return;
      setActiveId(null);
    }, inactiveTimeoutMs);
  }

  function attemptPersist(): void {
    setPersisting(true);
    if (persistingTimeout.current) clearTimeout(persistingTimeout.current);
    persistingTimeout.current = setTimeout(() => {
      setPersisting(false);
    }, PERSIST_TIMEOUT_MS);
  }

  function onMouseEnter(): void {
    resetDestructiveTimeouts();
    setHoveredId(id);
    setLocalHover(true);
  }

  function onMouseLeave(): void {
    setLocalHover(false);
    attemptDeactivate();
    attemptPersist();
  }

  useEffect(() => {
    // close instantly
    if (hide) {
      setLocalHover(false);
      setActiveId(null);
    }
  }, [hide, setActiveId]);

  function handleClick(e: React.MouseEvent): void {
    // Close if clicking a link. We assume we want the card to disappear if navigating.
    if (e.target instanceof HTMLElement && e.target.closest('a[href]')) {
      onMouseLeave();
    }
  }

  const Comp = asChild ? SlotRoot : 'div';

  return (
    <Comp
      className={cn(
        'inline-flex cursor-pointer flex-[0_1_auto] overflow-hidden',
        className
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={handleClick}
      ref={triggerRef}
    >
      <Slottable>{children}</Slottable>
      {portalRef?.current && (localHover || persisting)
        ? createPortal(
            <div
              className={cn(
                'absolute top-0 p-3 left-0 max-w-max transition-[transform,width,height] duration-250 ease-[easing-function:cubic-bezier(0.29,0.31,0.05,0.96)] will-change-[transform,width,height] motion-reduce:!transition-none',
                skipTransition && '!transition-none'
              )}
              key={id}
              ref={contentRef}
              style={{
                ...(noPadding ? { padding: 0 } : {}),
                pointerEvents:
                  rootVisible && visible && !ignoreCardPointerEvents
                    ? 'all'
                    : 'none',
              }}
            >
              <div
                className={cn(
                  'min-w-max transition-all duration-150 ease-[easing-function:cubic-bezier(0.3,_0.57,_0.07,_0.95)] will-change-[transform,width,height] motion-reduce:!transition-none',
                  skipTransition
                    ? '!transition-none'
                    : 'transition-[transform,width,height] duration-250 ease-[easing-function:cubic-bezier(0.29,0.31,0.05,0.96)] will-change-[transform,width,height] motion-reduce:!transition-none'
                )}
                ref={contentMeasureRef}
                style={{
                  opacity: Number(visible),
                }}
              >
                {content}
              </div>
            </div>,
            portalRef.current
          )
        : null}
    </Comp>
  );
}
