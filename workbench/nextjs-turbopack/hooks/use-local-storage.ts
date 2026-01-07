import { useCallback, useEffect, useState } from 'react';

/**
 * Generic hook for using localStorage with React state
 * Handles SSR hydration properly by loading from localStorage after mount
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  options?: {
    serializer?: (value: T) => string;
    deserializer?: (value: string) => T;
  }
): [T, (value: T | ((prev: T) => T)) => void, () => void, boolean] {
  const serializer = options?.serializer ?? JSON.stringify;
  const deserializer = options?.deserializer ?? JSON.parse;

  // Always start with initial value to match SSR
  const [storedValue, setStoredValue] = useState<T>(initialValue);
  const [isHydrated, setIsHydrated] = useState(false);

  // Load from localStorage after hydration (runs once on mount)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const item = window.localStorage.getItem(key);
        if (item) {
          setStoredValue(deserializer(item));
        }
      } catch (error) {
        console.error(`Error loading localStorage key "${key}":`, error);
      }
      setIsHydrated(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Save to localStorage whenever value changes (but not on initial hydration load)
  useEffect(() => {
    if (typeof window !== 'undefined' && isHydrated) {
      try {
        window.localStorage.setItem(key, serializer(storedValue));
      } catch (error) {
        console.error(`Error saving localStorage key "${key}":`, error);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, storedValue, isHydrated]);

  // Clear function to remove from localStorage
  const clearValue = useCallback(() => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(key);
      }
      setStoredValue(initialValue);
    } catch (error) {
      console.error(`Error removing localStorage key "${key}":`, error);
    }
  }, [key, initialValue]);

  return [storedValue, setStoredValue, clearValue, isHydrated];
}
