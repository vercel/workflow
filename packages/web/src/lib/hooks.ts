'use client';

import useSWR from 'swr';
import { checkWorldsAvailability } from './config-world';

export function useWorldsAvailability() {
  return useSWR('worlds-availability', checkWorldsAvailability, {
    revalidateOnFocus: false,
  });
}
