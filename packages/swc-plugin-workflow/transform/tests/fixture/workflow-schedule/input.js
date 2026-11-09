export async function nightlyReport(run) {
  'use workflow';
  return run.scheduledAt;
}
nightlyReport.experimental_schedule = {
  cron: '0 2 * * *',
  timezone: 'America/New_York',
  jitter: 5,
};

export const digest = async (run) => {
  'use workflow';
  return run.name;
};
digest.experimental_schedule = [
  { cron: '0 9 * * 1-5', name: 'weekday-digest' },
  { cron: `0 11 * * 0,6`, name: 'weekend-digest', jitter: 15 },
];

export async function unscheduled() {
  'use workflow';
}
