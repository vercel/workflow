import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getWorkbenchAppPath(overrideAppName?: string): string {
  const explicitWorkbenchPath = process.env.WORKBENCH_APP_PATH;
  const appName = process.env.APP_NAME ?? overrideAppName;
  if (
    explicitWorkbenchPath &&
    (!overrideAppName || !appName || overrideAppName === appName)
  ) {
    return path.resolve(explicitWorkbenchPath);
  }

  if (!appName) {
    throw new Error('`APP_NAME` environment variable is not set');
  }
  return path.join(__dirname, '../../../workbench', appName);
}
