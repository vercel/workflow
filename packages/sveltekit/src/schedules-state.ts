import type { BuildOutputSchedules } from '@workflow/builders';

/**
 * The workflows' `experimental_schedule` declarations from the last build in
 * this process. SvelteKit's Vercel adapter writes `.vercel/output/config.json`
 * after the workflow build, so the exit hook in `index.ts` adds these to it.
 */
let pending: BuildOutputSchedules = {};

export function setPendingSchedules(schedules: BuildOutputSchedules): void {
  pending = schedules;
}

export function takePendingSchedules(): BuildOutputSchedules {
  const schedules = pending;
  pending = {};
  return schedules;
}
