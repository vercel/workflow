export async function nightlyReport() {
  'use workflow';
}

function helper() {}
helper.experimental_schedule = { cron: '0 2 * * *' };
