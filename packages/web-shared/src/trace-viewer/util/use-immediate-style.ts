import type { CSSProperties, MutableRefObject } from 'react';
import { useCallback, useRef } from 'react';

type SetStyle = (propertyName: string, value: string | undefined) => void;

interface ImmediateStyle {
  setStyle: SetStyle;
  styleRef: MutableRefObject<CSSProperties>;
  style: CSSProperties;
}

/**
 * Update an element's style without forcing renders, but in a way that is still
 * safe if the element re-renders for another reason.
 * @returns The current style & a method to update the style
 */
export function useImmediateStyle(
  ref: MutableRefObject<HTMLElement | null>
): ImmediateStyle {
  const styleRef = useRef<CSSProperties>({});
  const setStyle = useCallback<SetStyle>(
    (propertyName, value) => {
      // @ts-expect-error typeof keyof CSSProperties is too big of a union
      styleRef.current[propertyName] = value;
      if (!ref.current) return;
      if (!value) {
        ref.current.style.removeProperty(propertyName);
        return;
      }
      ref.current.style.setProperty(propertyName, value);
    },
    [ref]
  );

  return { setStyle, styleRef, style: { ...styleRef.current } };
}
