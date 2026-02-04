import { SwcPlayground } from '@/components/swc-playground';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function getPluginVersion(): string {
  try {
    // Read directly from node_modules
    const pkgJsonPath = join(
      process.cwd(),
      'node_modules/@workflow/swc-plugin/package.json'
    );
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    return pkgJson.version;
  } catch {
    return '';
  }
}

export default function Page() {
  const pluginVersion = getPluginVersion();
  return <SwcPlayground pluginVersion={pluginVersion} />;
}
