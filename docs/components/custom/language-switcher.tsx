'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Children,
  isValidElement,
  type JSX,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useSyncExternalStore,
} from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

const QUERY_PARAM = 'language';

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
  py: 'Python',
  python: 'Python',
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

function useLanguageStore(
  defaultValue: string,
  availableValues: string[]
): [string, (value: string) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const sharedValue = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

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
      params.set(QUERY_PARAM, value);
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

function LanguageUrlSyncer(): null {
  const searchParams = useSearchParams();
  const urlLanguage = searchParams.get(QUERY_PARAM);

  useEffect(() => {
    if (urlLanguage && urlLanguage !== currentLanguage) {
      setLanguage(urlLanguage);
    }
  }, [urlLanguage]);

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
        <LanguageUrlSyncer />
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
