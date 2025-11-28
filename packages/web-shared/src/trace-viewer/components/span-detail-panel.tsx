'use client';

import { clsx } from 'clsx';
import type { PointerEventHandler, ReactNode } from 'react';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { initialState, useTraceViewer } from '../context';
import styles from '../trace-viewer.module.css';
import type {
  GetQuickLinks,
  QuickLinkValue,
  RootNode,
  Span,
  SpanNode,
  TraceNode,
} from '../types';
import { formatDuration } from '../util/timing';
import { getSpanColorClassName } from './node';
import {
  ButtonLink,
  IconChevronDown,
  IconCross,
  IconExternalSmall,
  Link,
  Note,
  Skeleton,
} from './ui';

const percentage = (n: number): string => `${(100 * n).toFixed(3)}%`;

interface GroupedAttribute {
  prefix: string;
  attributes: Attribute[];
}

interface Attribute {
  suffix: string;
  key: string;
  value: string;
}

const sortWord = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  } else if (a > b) {
    return 1;
  }
  return 0;
};

const getGroupedAttributes = (
  attributes: Span['attributes']
): GroupedAttribute[] => {
  // Build groups of items with the same prefix
  const groups: Record<string, GroupedAttribute> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const dotIndex = key.indexOf('.');
    let prefix = '';
    let suffix = '';
    if (dotIndex !== -1) {
      prefix = key.substring(0, dotIndex);
      suffix = key.substring(dotIndex + 1);
    } else {
      suffix = key;
    }

    let group = groups[prefix];
    if (!group) {
      group = {
        prefix,
        attributes: [],
      };
      groups[prefix] = group;
    }
    group.attributes.push({
      key,
      suffix,
      value: String(value),
    });
  }

  // List and sort everything
  const result = Array.from(Object.values(groups)).sort((a, b) =>
    sortWord(a.prefix, b.prefix)
  );
  for (const group of result) {
    group.attributes.sort((a, b) => sortWord(a.suffix, b.suffix));
  }
  return result;
};

// biome-ignore lint/correctness/noUnusedFunctionParameters: ignored using `--suppress`
const getAncestors = (_root: RootNode, start: SpanNode | null): SpanNode[] => {
  const result: SpanNode[] = [];

  if (!start) return result;

  for (let node: TraceNode = start; 'parent' in node; node = node.parent) {
    result.unshift(node);
  }

  return result;
};

export const SpanDetailPanelBody = () => {
  const {
    state: { root, selected, resourceMap, getQuickLinks },
    dispatch,
  } = useTraceViewer();

  const ancestors = useMemo(
    () => getAncestors(root, selected),
    [root, selected]
  );

  const attributeGroups = useMemo(
    () => getGroupedAttributes(selected?.span.attributes ?? {}),
    [selected]
  );

  const resourceAttributeGroups = useMemo(() => {
    const resourceName = selected?.span.resource;
    if (!resourceName) return [];
    const resourceAttributes = resourceMap[resourceName];
    if (!resourceAttributes) return [];
    return getGroupedAttributes(resourceAttributes);
  }, [resourceMap, selected]);

  if (!selected) return null;

  const { span } = selected;

  const isEntrySpan = detectIsEntrySpan(selected);

  return (
    <>
      {selected.isVercel ? <InfraSpanDescription node={selected} /> : null}
      {selected.isInstrumentationHint ? <InstrumentationHint /> : null}
      {!selected.isInstrumentationHint && ancestors.length ? (
        <DetailGroup className={styles.ancestorGroup} name="Location">
          {ancestors.map((node) => (
            <button
              className={styles.ancestorNode}
              key={`${selected.span.spanId}.${node.span.spanId}`}
              onClick={() =>
                dispatch({
                  type: 'select',
                  id: node.span.spanId,
                })
              }
              type="button"
            >
              <div className={styles.ancestorText}>
                <span className={styles.ancestorName}>
                  {node.label || node.span.name}
                </span>
                <span className={styles.ancestorDuration}>
                  {formatDuration(node.duration)}
                </span>
              </div>
              <span aria-hidden className={styles.ancestorLineContainer}>
                <span
                  className={clsx(
                    styles.ancestorLine,
                    getSpanColorClassName(node)
                  )}
                  style={{
                    left: percentage(
                      (node.startTime - root.startTime) / root.duration
                    ),
                    width: percentage(node.duration / root.duration),
                  }}
                />
              </span>
            </button>
          ))}
        </DetailGroup>
      ) : null}
      {isEntrySpan ? (
        <EntrySpanLinks getQuickLinks={getQuickLinks} span={selected.span} />
      ) : null}
      {selected.events?.length ? (
        <DetailGroup name="Events">
          {selected.events.map((event) => (
            <Fragment key={event.key}>
              <dl className={styles.spanDetailPanelAttribute}>
                <dt className={styles.spanDetailPanelAttributeKey}>
                  {event.event.name}
                </dt>
                <dd className={styles.spanDetailPanelAttributeValue}>
                  {formatDuration(event.timestamp - root.startTime)}
                </dd>
              </dl>
              {Object.entries(event.event.attributes).map(([key, value]) => (
                <DetailLine
                  key={key}
                  name={`${event.event.name}.${key}`}
                  value={value}
                />
              ))}
            </Fragment>
          ))}
        </DetailGroup>
      ) : null}
      {attributeGroups.length ? (
        <DetailGroup name="Attributes">
          {attributeGroups.map((group) => (
            <Fragment key={group.prefix}>
              {group.attributes.map(({ key, value }) => (
                <DetailLine key={key} name={key} value={value} />
              ))}
            </Fragment>
          ))}
        </DetailGroup>
      ) : null}
      {resourceAttributeGroups.length ? (
        <DetailGroup name="Resource">
          {resourceAttributeGroups.map((group) => (
            <Fragment key={group.prefix}>
              {group.attributes.map(({ key, value }) => (
                <DetailLine key={key} name={key} value={value} />
              ))}
            </Fragment>
          ))}
        </DetailGroup>
      ) : null}
      {selected.isInstrumentationHint ? null : (
        <DetailGroup name="Library">
          <DetailLine name="name" value={span.library.name} />
          {span.library.version ? (
            <DetailLine name="version" value={span.library.version} />
          ) : null}
        </DetailGroup>
      )}
    </>
  );
};

export function SpanDetailPanel({
  attached = false,
}: {
  attached?: boolean;
}): ReactNode {
  const {
    state: { selected, isMobile, customPanelComponent },
    dispatch,
  } = useTraceViewer();

  if (!selected) return null;

  const { span } = selected;

  return (
    <div className={clsx(styles.spanDetailPanel, isMobile && styles.mobile)}>
      {attached && !isMobile ? <PanelResizer /> : null}
      <div className={styles.spanDetailPanelTop}>
        <div className={styles.spanDetailPanelTopInfo}>
          {/* Name/ID first */}
          <span className={styles.spanDetailPanelName} title={span.name}>
            {span.name}
          </span>
          {/* Right side: duration badge, separator, close */}
          <div className={styles.spanDetailPanelCorner}>
            {selected.isInstrumentationHint ? null : (
              <span className={styles.spanDetailPanelDuration}>
                {formatDuration(selected.duration)}
              </span>
            )}
            <div className={styles.spanDetailPanelCloseVerticalRule} />
            <button
              aria-label="Close Span Details"
              className={styles.spanDetailPanelClose}
              onClick={() =>
                dispatch({
                  type: 'deselect',
                })
              }
              type="button"
            >
              <IconCross color="gray-700" size={20} />
            </button>
          </div>
        </div>
      </div>
      <div className={clsx('flex gap-3', styles.spanDetailPanelBody)}>
        {customPanelComponent || <SpanDetailPanelBody />}
      </div>
    </div>
  );
}

const EXPANDED_STORAGE_KEY_PREFIX = 'vc-trace-span-exp:';

function DetailGroup({
  name,
  className = '',
  children,
}: {
  name: string;
  className?: string;
  children: ReactNode;
}): ReactNode {
  const [isExpanded, setIsExpanded] = useState(() => {
    if (!('localStorage' in globalThis)) return true;
    return (
      localStorage.getItem(`${EXPANDED_STORAGE_KEY_PREFIX}${name}`) !== '0'
    );
  });

  const toggleExpanded = useCallback(() => {
    setIsExpanded((x) => {
      const willBeExpanded = !x;
      localStorage.setItem(
        `${EXPANDED_STORAGE_KEY_PREFIX}${name}`,
        String(Number(willBeExpanded))
      );
      return willBeExpanded;
    });
  }, [name]);

  return (
    <div
      className={clsx(
        styles.detailGroup,
        isExpanded ? styles.expanded : styles.collapsed,
        className
      )}
    >
      <button
        className={styles.detailHeading}
        onClick={toggleExpanded}
        type="button"
      >
        <span>{name}</span>
        <IconChevronDown />
      </button>
      {isExpanded ? children : null}
    </div>
  );
}

const CommonHttpVerbs = new Set([
  'OPTIONS',
  'HEAD',
  'GET',
  'PUT',
  'POST',
  'DELETE',
]);
const KnownSpans: Record<string, string> = {
  'Resolve Deployment': `How long it took Vercel's routing layer to retrieve details for the deployment.`,
  'Resolve Cache': `How long it took Vercel's routing layer to check for a cached function invocation.`,
  'Resolve Route': `How long it took Vercel's routing layer to resolve routing rules, including redirects and rewrites.`,
  'Invoke Middleware': `How long it took this middleware to start and run user code.`,
  'Invoke Function': `How long it took this Vercel Function to start and run user code.`,
  waitUntil: `How long it took to run user code inside of waitUntil.`,
  'Start VM': `How long it took to start the Virtual Machine which contains the Vercel Function.`,
  'Spawn Node.js': `How long it took the Virtual Machine to start the Node.js runtime.`,
  'Spawn Python': `How long it took the Virtual Machine to start the Python runtime.`,
  'Init User Code': `How long it took to import the user code and run any globally-scoped code.`,
};

const ColdStartSpanNames = new Set([
  'Start VM',
  'Spawn Node.js',
  'Spawn Python',
  'Init User Code',
]);

const getRegion = (
  node: SpanNode | RootNode | null | undefined
): string | null => {
  if (!node || !('span' in node)) {
    return null;
  }

  const attr = node.span.attributes;
  const region = attr['vercel.region'] || attr['vercel.function.region'];
  if (region) return String(region);
  return null;
};

const getNote = (node: SpanNode): ReactNode => {
  const { name } = node.span;
  const region = getRegion(node);
  const parentRegion = getRegion(node.parent);

  if (node.span.attributes['vercel.middleware.internal'] === 'true') {
    return 'The Vercel Toolbar created this middleware.';
  } else if (
    ColdStartSpanNames.has(name) ||
    (name === 'Invoke Function' &&
      node.children.some((x) => ColdStartSpanNames.has(x.span.name)))
  ) {
    return 'This function encountered a cold start.';
  } else if (region && parentRegion && region !== parentRegion) {
    return 'This request was routed across regions.';
  }

  return null;
};

const detectIsEntrySpan = (node: SpanNode): boolean => {
  if (!node.isVercel) return false;
  const { name } = node.span;
  const spaceIndex = name.indexOf(' ');
  if (spaceIndex === -1) return false;
  const firstWord = name.substring(0, spaceIndex);
  return CommonHttpVerbs.has(firstWord);
};

function InfraSpanDescription({ node }: { node: SpanNode }): ReactNode {
  const { name } = node.span;
  let description = KnownSpans[name];

  if (!description && detectIsEntrySpan(node)) {
    description = `How long it took for Vercel to process the request and send the response.`;
  }

  if (!description) return null;

  const note = getNote(node);

  return (
    <DetailGroup name="What is this?">
      <div className={styles.infraSpanDescription}>
        <span>{description}</span>
        {note ? <Note>{note}</Note> : note}
      </div>
    </DetailGroup>
  );
}

const EntrySpanLinks = memo(function EntrySpanLinks({
  getQuickLinks,
  span,
}: {
  getQuickLinks: GetQuickLinks;
  span: Span;
}): ReactNode {
  const links = getQuickLinks(span);

  if (!links.length) return null;

  return (
    <DetailGroup name="Links">
      {links.map(({ key, value }) => (
        <EntrySpanLink key={key} link={value} name={key} />
      ))}
    </DetailGroup>
  );
});

interface ResolvablePromise<T> extends Promise<T> {
  __resolvedValue?: T;
  __rejectedValue?: unknown;
}

function usePromise<T>(promise: ResolvablePromise<T>): T | undefined {
  const [_, setLatest] = useState({});
  const fulfilled =
    promise.__resolvedValue !== undefined ||
    promise.__rejectedValue !== undefined;
  useEffect(() => {
    if (fulfilled) return;

    promise
      .then((value) => {
        promise.__resolvedValue = value;
      })
      .catch((err) => {
        promise.__rejectedValue = err;
      })
      .finally(() => setLatest({}));
  }, [promise, fulfilled]);

  return promise.__resolvedValue;
}

function EntrySpanLink({
  name,
  link: linkPromise,
}: {
  name: string;
  link: Promise<QuickLinkValue>;
}): ReactNode {
  const link = usePromise(linkPromise);

  return (
    <Link
      as={link ? undefined : 'span'}
      className={clsx(
        styles.spanDetailPanelAttribute,
        styles.spanDetailPanelQuickLink
      )}
      href={link?.href || ''}
    >
      <span className={styles.spanDetailPanelAttributeKey}>{name}</span>
      <span
        className={clsx(
          styles.spanDetailPanelAttributeValue,
          styles.spanDetailPanelQuickLinkLabel
        )}
      >
        {link ? (
          <>
            {link.label}
            {link.icon || <IconExternalSmall color="gray-900" />}
          </>
        ) : (
          <>
            <Skeleton height={18} width={32 + name.length * 8} />
            <Skeleton height={18} rounded width={18} />
          </>
        )}
      </span>
    </Link>
  );
}

function InstrumentationHint(): ReactNode {
  return (
    <DetailGroup name="What is this?">
      <div className={styles.infraSpanDescription}>
        <span>{`You can visualize your application's spans alongside Vercel's spans in this viewer.`}</span>
        <ButtonLink
          href="https://vercel.com/docs/session-tracing#adding-custom-spans"
          size="small"
          target="_blank"
        >
          Get Started
        </ButtonLink>
      </div>
    </DetailGroup>
  );
}

function DetailLine({
  name,
  value,
}: {
  name: string;
  value: unknown;
}): ReactNode {
  return (
    <dl className={styles.spanDetailPanelAttribute}>
      <dt className={styles.spanDetailPanelAttributeKey}>{name}</dt>
      <dd
        className={styles.spanDetailPanelAttributeValue}
        title={String(value)}
      >
        {String(value)}
      </dd>
    </dl>
  );
}

interface ResizeGestureRef {
  start: {
    x: number;
    width: number;
  };
  x: number;
  width: number;
  isHeld: boolean;
}

/**
 * Resizer component for the trace viewer panel.
 */
export function PanelResizer(): ReactNode {
  const {
    state: { panelWidth },
    dispatch,
  } = useTraceViewer();
  const gestureRef = useRef<ResizeGestureRef>({
    start: {
      x: 0,
      width: panelWidth,
    },
    x: 0,
    width: panelWidth,
    isHeld: false,
  });
  gestureRef.current.width = panelWidth;

  const onPointerDown = useCallback<PointerEventHandler>((event) => {
    if (event.pointerType !== 'mouse') return;
    event.preventDefault();
    const g = gestureRef.current;
    g.start.x = event.clientX;
    g.x = event.clientX;
    g.start.width = g.width;
    g.isHeld = true;
  }, []);

  const onDoubleClick = useCallback(() => {
    dispatch({
      type: 'setPanelWidth',
      width: initialState.panelWidth,
    });
  }, [dispatch]);

  useEffect(() => {
    let nextFrame = 0;
    const onFrame = (): void => {
      const g = gestureRef.current;
      const width = g.start.width + g.start.x - g.x;
      dispatch({
        type: 'setPanelWidth',
        width,
      });
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!gestureRef.current.isHeld) return;
      event.preventDefault();
      gestureRef.current.x = event.clientX;
      cancelAnimationFrame(nextFrame);
      nextFrame = requestAnimationFrame(onFrame);
    };
    const onPointerUp = (): void => {
      gestureRef.current.isHeld = false;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [dispatch]);

  return (
    <div
      aria-hidden
      className={styles.spanDetailPanelResizer}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
    />
  );
}
