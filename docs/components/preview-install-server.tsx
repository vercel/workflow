import { PreviewInstall } from './preview-install';

/**
 * Server component wrapper that reads VERCEL_URL at build/render time
 * and passes it to the client component. For use in MDX pages.
 */
export function PreviewInstallServer() {
  const deploymentUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  return <PreviewInstall deploymentUrl={deploymentUrl} />;
}
