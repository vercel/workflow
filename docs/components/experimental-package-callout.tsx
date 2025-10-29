import * as CalloutComponents from '@/components/ui/callout';

interface ExperimentalPackageCalloutProps {
  packageName: string;
}

export function ExperimentalPackageCallout({
  packageName,
}: ExperimentalPackageCalloutProps) {
  return (
    <CalloutComponents.Callout type="warn">
      The <code>{packageName}</code> package is currently in active development
      and should be considered experimental.
    </CalloutComponents.Callout>
  );
}
