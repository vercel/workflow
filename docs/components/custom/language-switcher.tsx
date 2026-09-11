'use client';

import Link from 'fumadocs-core/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Children,
  type ComponentProps,
  createElement,
  isValidElement,
  type JSX,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useSyncExternalStore,
} from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { rewriteHrefForVersion } from '@/lib/geistdocs/version-href';
import { getVersionFromPathname } from '@/lib/geistdocs/versions';
import { LANGUAGE_QUERY_PARAM, resolveLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

const listeners = new Set<() => void>();
let currentLanguage: string | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return currentLanguage;
}

function getServerSnapshot(): string | null {
  return null;
}

function setLanguage(value: string): void {
  currentLanguage = value;
  for (const listener of listeners) {
    listener();
  }
}

const DEFAULT_TITLES: Record<string, string> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  py: 'Python (beta)',
  python: 'Python (beta)',
  ts: 'TypeScript',
  typescript: 'TypeScript',
};

function getDefaultTitle(value: string): string {
  return DEFAULT_TITLES[value] ?? value;
}

interface LanguageSwitcherTabProps {
  value: string;
  title?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  tooltip?: string;
  children?: ReactNode;
}

interface LanguageSwitcherProps {
  defaultValue?: string;
  /**
   * Render only the selected panel so the switcher matches its height. By
   * default, panels share the height of the tallest option to avoid layout
   * shift when the language changes.
   */
  compactHeight?: boolean;
  className?: string;
  children: ReactNode;
}

interface LanguageContentProps {
  inline?: boolean;
  value: string;
  className?: string;
  children?: ReactNode;
}

type LanguageTextProps = Record<string, ReactNode>;

interface LanguageLinkProps {
  children?: ReactNode;
  className?: string;
  title?: string;
  target?: ComponentProps<'a'>['target'];
  rel?: string;
  [language: string]: unknown;
}

// TOCs are compiled independently of LanguageContent. Match their links to the
// rendered heading IDs so both the sidebar and the portaled mobile TOC follow
// the same `hidden` state as the body, including nested language blocks.
function syncLanguageToc(element: Element | null): (() => void) | undefined {
  if (!element) return;

  const style = document.createElement('style');
  const update = () => {
    const selectors = Array.from(
      element.querySelectorAll('h2[id], h3[id], h4[id], h5[id], h6[id]'),
      (heading) => {
        const id = CSS.escape(heading.id);
        const href = CSS.escape(`#${heading.id}`);
        return `:root:has([data-language][hidden] #${id}) :is(#nd-toc, [data-geistdocs-mobile-toc]) a[href="${href}"]`;
      }
    );
    style.textContent = selectors.length
      ? `${selectors.join(',\n')} { display: none; }`
      : '';
  };

  update();
  document.head.append(style);
  // MDX can stream or replace descendants after the language block mounts.
  const observer = new MutationObserver(update);
  observer.observe(element, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['id'],
  });

  return () => {
    observer.disconnect();
    style.remove();
  };
}

interface PageLanguageSwitcherProps {
  languages: readonly string[];
  className?: string;
}

function useSharedLanguage(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function useLanguageStore(
  defaultValue: string,
  availableValues: string[]
): [string, (value: string) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const sharedValue = useSharedLanguage();

  const fallbackValue = availableValues.includes(defaultValue)
    ? defaultValue
    : (availableValues[0] ?? '');
  const selected =
    sharedValue && availableValues.includes(sharedValue)
      ? sharedValue
      : fallbackValue;

  const updateSelected = useCallback(
    (value: string) => {
      setLanguage(value);

      const params = new URLSearchParams(window.location.search);
      params.set(LANGUAGE_QUERY_PARAM, value);
      const query = params.toString();
      router.replace(
        `${pathname}${query ? `?${query}` : ''}${window.location.hash}`,
        { scroll: false }
      );
    },
    [pathname, router]
  );

  return [selected, updateSelected];
}

function LanguageUrlSyncer({
  languages,
  defaultValue,
}: {
  languages: readonly string[];
  defaultValue: string;
}): null {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const urlLanguage = searchParams.get(LANGUAGE_QUERY_PARAM);
  const languageValues = JSON.stringify(languages);

  useEffect(() => {
    const available: string[] = JSON.parse(languageValues);
    const fallback = resolveLanguage(available, defaultValue);
    const requested = urlLanguage || currentLanguage;
    const selected =
      requested && available.includes(requested) ? requested : fallback;
    if (selected !== currentLanguage) setLanguage(selected);

    // A selection survives client-side navigation. Keep the next page's URL
    // in sync so its View as Markdown and Copy page actions export that language.
    // Read the store only on URL changes; an in-flight router.replace must not
    // undo a selection made by the user before the new URL arrives.
    if (
      selected !== urlLanguage &&
      (urlLanguage !== null || selected !== fallback)
    ) {
      const params = new URLSearchParams(window.location.search);
      params.set(LANGUAGE_QUERY_PARAM, selected);
      router.replace(`${pathname}?${params}${window.location.hash}`, {
        scroll: false,
      });
    }
  }, [defaultValue, languageValues, pathname, router, urlLanguage]);

  return null;
}

/**
 * Defines one language panel inside a {@link LanguageSwitcher}.
 */
export function LanguageSwitcherTab(
  _props: LanguageSwitcherTabProps
): JSX.Element | null {
  return null;
}

function getTabChildren(children: ReactNode) {
  return Children.toArray(children).filter(
    (child): child is ReactElement<LanguageSwitcherTabProps> =>
      isValidElement<LanguageSwitcherTabProps>(child) &&
      typeof child.props.value === 'string'
  );
}

function LanguagePanels({
  compactHeight,
  selected,
  tabs,
}: {
  compactHeight: boolean;
  selected: string;
  tabs: ReactElement<LanguageSwitcherTabProps>[];
}): JSX.Element | null {
  if (compactHeight) {
    const selectedTab =
      tabs.find((tab) => tab.props.value === selected) ?? tabs[0];

    return selectedTab ? (
      <TabsContent className="pt-4" value={selectedTab.props.value}>
        {selectedTab.props.children}
      </TabsContent>
    ) : null;
  }

  return (
    <div className="grid">
      {tabs.map((tab) => {
        const isSelected = tab.props.value === selected;

        return (
          <TabsContent
            aria-hidden={!isSelected}
            className={cn(
              'col-start-1 row-start-1 min-w-0 pt-4',
              isSelected ? 'visible' : 'invisible pointer-events-none'
            )}
            forceMount
            key={tab.props.value}
            tabIndex={isSelected ? 0 : -1}
            value={tab.props.value}
          >
            {tab.props.children}
          </TabsContent>
        );
      })}
    </div>
  );
}

/**
 * Renders language-specific MDX content. Every switcher on the page shares the
 * selected language, and the selection is reflected in the `language` query
 * parameter so links can open with the intended language selected.
 */
export function LanguageSwitcher({
  children,
  className,
  compactHeight = false,
  defaultValue = 'ts',
}: LanguageSwitcherProps): JSX.Element | null {
  const tabs = getTabChildren(children);
  const enabledValues = tabs
    .filter((tab) => !tab.props.disabled)
    .map((tab) => tab.props.value);
  const availableValues =
    enabledValues.length > 0
      ? enabledValues
      : tabs.map((tab) => tab.props.value);
  const [selected, setSelected] = useLanguageStore(
    defaultValue,
    availableValues
  );

  if (tabs.length === 0) {
    return null;
  }

  return (
    <>
      <Suspense fallback={null}>
        <LanguageUrlSyncer
          defaultValue={defaultValue}
          languages={availableValues}
        />
      </Suspense>
      <Tabs
        className={cn('my-4 gap-0', className)}
        onValueChange={setSelected}
        value={selected}
        variant="underline"
      >
        {tabs.length > 1 ? (
          <TabsList
            aria-label="Programming language"
            className="w-full justify-start overflow-x-auto"
          >
            {tabs.map((tab) => (
              <TabsTrigger
                disabled={tab.props.disabled}
                key={tab.props.value}
                title={tab.props.tooltip}
                value={tab.props.value}
              >
                {tab.props.icon}
                {tab.props.title ?? getDefaultTitle(tab.props.value)}
              </TabsTrigger>
            ))}
          </TabsList>
        ) : null}
        <LanguagePanels
          compactHeight={compactHeight}
          selected={selected}
          tabs={tabs}
        />
      </Tabs>
    </>
  );
}

function PageLanguageSwitcherImpl({
  className,
  languages,
}: PageLanguageSwitcherProps): JSX.Element | null {
  const [selected, setSelected] = useLanguageStore(languages[0] ?? 'ts', [
    ...languages,
  ]);

  if (languages.length < 2) {
    return null;
  }

  return (
    <div className={cn('mb-6', className)} data-page-language-switcher>
      <Suspense fallback={null}>
        <LanguageUrlSyncer
          defaultValue={languages[0] ?? 'ts'}
          languages={languages}
        />
      </Suspense>
      <Select onValueChange={setSelected} value={selected}>
        <SelectTrigger
          aria-label="Programming language"
          className="w-full bg-background-100"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {languages.map((language) => (
            <SelectItem key={language} value={language}>
              {getDefaultTitle(language)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Renders the language selector only for pages that opt in via frontmatter. */
export function PageLanguageSwitcher(
  props: PageLanguageSwitcherProps
): JSX.Element {
  return (
    <Suspense fallback={null}>
      <PageLanguageSwitcherImpl {...props} />
    </Suspense>
  );
}

/**
 * Shows content for the selected language, using a span when inline is set.
 */
export function LanguageContent({
  inline = false,
  children,
  className,
  value,
}: LanguageContentProps): JSX.Element {
  const selected = useSharedLanguage() ?? 'ts';
  const Component = inline ? 'span' : 'div';

  return createElement(
    Component,
    {
      ref: syncLanguageToc,
      className,
      'data-language': value,
      hidden: selected !== value,
    },
    children
  );
}

/** Selects one inline value, provided as a prop named after each language. */
export function LanguageText(values: LanguageTextProps): JSX.Element {
  const selected = useSharedLanguage() ?? 'ts';

  return <>{values[selected]}</>;
}

/** Selects a destination URL, provided as a prop named after each language. */
export function LanguageLink({
  children,
  className,
  title,
  target,
  rel,
  ...destinations
}: LanguageLinkProps): JSX.Element | null {
  const selected = useSharedLanguage() ?? 'ts';
  const pathname = usePathname();
  const href = destinations[selected];

  if (href === undefined) return null;
  if (typeof href !== 'string') {
    throw new TypeError(
      `LanguageLink destination "${selected}" must be a string`
    );
  }

  // Apply the same version rewrite as Markdown links without passing a
  // page-specific server component across the client boundary.
  const version = getVersionFromPathname(pathname);
  return (
    <Link
      href={rewriteHrefForVersion(href, version.prefix)}
      prefetch
      className={className}
      title={title}
      target={target}
      rel={rel}
    >
      {children}
    </Link>
  );
}
