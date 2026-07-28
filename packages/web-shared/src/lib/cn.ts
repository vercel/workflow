import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMergeConfig = {
  extend: {
    classGroups: {
      'text-heading': [
        {
          'text-heading': [
            '72',
            '64',
            '56',
            '48',
            '40',
            '32',
            '24',
            '20',
            '16',
            '14',
          ],
        },
      ],
      'text-button': [
        {
          'text-button': ['16', '14', '12'],
        },
      ],
      'text-label': [
        {
          'text-label': [
            '20',
            '18',
            '16',
            '14',
            '14-mono',
            '13',
            '13-mono',
            '12',
            '12-mono',
          ],
        },
      ],
      'text-copy': [
        {
          'text-copy': ['24', '20', '18', '16', '14', '13', '13-mono'],
        },
      ],
      material: [
        {
          material: [
            'base',
            'small',
            'medium',
            'large',
            'tooltip',
            'menu',
            'modal',
            'fullscreen',
          ],
        },
      ],
    },
    // Make each category conflict with itself, so e.g. text-heading-32 overrides text-heading-24
    conflictingClassGroups: {
      'text-heading': ['text-heading'],
      'text-button': ['text-button'],
      'text-label': ['text-label'],
      'text-copy': ['text-copy'],
      material: ['material'],
    },
  },
} as const;

type CustomClassGroupIds =
  | 'text-heading'
  | 'text-button'
  | 'text-label'
  | 'text-copy'
  | 'material';

const customTwMerge = extendTailwindMerge<CustomClassGroupIds>(twMergeConfig);

/**
 * Merges Tailwind class names and resolves any conflicts using `clsx` with `tailwind-merge`.
 *
 * @param inputs - An array of class names to merge.
 * @returns A string of merged and optimized class names.
 */
function cn(...classes: ClassValue[]) {
  return customTwMerge(clsx(...classes));
}

export { cn };
