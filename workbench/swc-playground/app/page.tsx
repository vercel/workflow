import { SwcPlayground } from '@/components/swc-playground';
import pluginPkg from '../../../packages/swc-plugin-workflow/package.json';

export default function Page() {
  const gitCommitSha = process.env.VERCEL_GIT_COMMIT_SHA;
  return (
    <SwcPlayground
      pluginVersion={pluginPkg.version}
      gitCommitSha={gitCommitSha}
    />
  );
}
