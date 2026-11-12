const CRON = '0 2 * * *';

export async function nightlyReport() {
  'use workflow';
}
nightlyReport.experimental_schedule = { cron: CRON };
