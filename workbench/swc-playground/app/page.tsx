import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SwcPlayground } from '@/components/swc-playground';

function getPluginVersion(): string {
  try {
    // Read directly from node_modules
    const pkgJsonPath = join(
      process.cwd(),
      'node_modules/@workflow/swc-plugin/package.json'
    );
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    return pkgJson.version;
  } catch (error) {
    console.error(
      'Failed to read @workflow/swc-plugin version from package.json:',
      error
    );
    return 'unknown';
  }
}

export default function Page() {
  const pluginVersion = getPluginVersion();
  return <SwcPlayground pluginVersion={pluginVersion} />;
}
